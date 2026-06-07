import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadoLivreClient, MlOrder } from '../clients/mercado-livre-client'
import { MessagingService } from '../../messaging/messaging.service'
import { NewSaleNotifierService } from './new-sale-notifier.service'
import { StockService } from '../../stock/stock.service'
import { FulfillmentService } from '../../fulfillment/fulfillment.service'

interface ProductInfo {
  product_id: string
  cost_price: number | null
  tax_percentage: number | null
  tax_on_freight: boolean
  sku: string | null
}

interface IngestionStats {
  ordersFound: number
  rowsUpserted: number
  apiCalls: number
  errors: Array<{ date: string; error: string }>
}

type BuyerSnapshot = {
  doc_type:        string | null
  doc_number:      string | null
  email:           string | null
  phone:           string | null
  name:            string | null
  last_name:       string | null
  billing_info_id: string | null
  billing_address: Record<string, unknown> | null
  billing_country: string | null
  fetched_at:      string | null
}

/** In-memory snapshot of the last sync — surfaced by GET /sales-aggregator/sync-stats. */
export type LastSyncStats = {
  at:                string
  orders_processed:  number
  with_cpf:          number
  failed:            number
  duplicates:        number
  duration_ms:       number
} | null

const BILLING_BATCH      = 3      // 3 paralelos por batch
const BILLING_BATCH_GAP  = 1000   // 1s entre batches → ~3 req/s sustentado

@Injectable()
export class OrdersIngestionService {
  private readonly logger = new Logger(OrdersIngestionService.name)
  private lastStats: LastSyncStats = null

  constructor(
    private readonly mlClient:    MercadoLivreClient,
    private readonly messaging:   MessagingService,
    private readonly newSaleNotifier: NewSaleNotifierService,
    private readonly stock:       StockService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  /** Public — surfaces the last sync result for /sync-stats. */
  getLastStats(): LastSyncStats { return this.lastStats }

  /** Webhook-driven single-order ingest.
   *
   *  Quando ML manda webhook orders_v2 com /orders/{id}, dispatcher
   *  chama isso pra fazer upsert imediato (não espera aggregator
   *  periódico). Latência observada: ~2-4s do bipe ao DB.
   *
   *  CRITICAL: o `sellerId` precisa ser passado pelo dispatcher (vem do
   *  payload do webhook = `payload.user_id`). Sem isso, em orgs com mais
   *  de 1 conta ML conectada, getTokenForOrg pega a conta com updated_at
   *  mais recente — pode ser a errada — e fetchOrder retorna 404 porque
   *  o token não tem acesso àquele pedido. Resultado: upserted=0, pedido
   *  some, UI nunca atualiza. */
  async ingestSingleOrder(
    orgId: string,
    externalOrderId: string | number,
    sellerIdHint?: number,
  ): Promise<{
    upserted: number
    skipped:  boolean
    reason?:  string
  }> {
    const t0 = Date.now()
    let token: string, sellerId: number
    try {
      ({ token, sellerId } = await this.mlClient.getTokenForOrg(orgId, sellerIdHint))
    } catch (e) {
      this.logger.warn(`[single-ingest] org=${orgId} seller=${sellerIdHint ?? 'auto'} sem token ML: ${(e as Error).message}`)
      return { upserted: 0, skipped: true, reason: 'no_ml_token' }
    }

    // 1. Fetch order do ML
    let order: MlOrder
    try {
      const raw = await this.mlClient.fetchOrder(token, externalOrderId)
      if (!raw || typeof raw !== 'object') {
        return { upserted: 0, skipped: true, reason: 'order_not_found' }
      }
      order = raw as MlOrder
    } catch (e) {
      this.logger.warn(`[single-ingest] fetchOrder ${externalOrderId} falhou: ${(e as Error).message}`)
      return { upserted: 0, skipped: true, reason: 'fetch_failed' }
    }

    // 2. Shipping breakdown (sender/receiver/gross/ml_refund)
    const costMap = new Map<number, number>()
    const breakdownMap = new Map<number, { sender_cost: number; receiver_cost: number; gross_amount: number; ml_refund: number }>()
    const shipId = order.shipping?.id
    if (shipId) {
      try {
        const bd = await this.mlClient.fetchShipmentBreakdown(token, shipId)
        breakdownMap.set(shipId, bd)
        costMap.set(shipId, bd.sender_cost)
      } catch { /* best-effort, default 0 */ }

      // 2b. Shipment FULL — pega receiver_address (state/city) e demais
      //     campos de envio que /orders/{id} não retorna (vem só
      //     `shipping: {id}`). Sem isso, mapa "Vendas por Região" fica
      //     zerado em todo pedido novo. Best-effort; falha não derruba.
      try {
        const sh = await this.mlClient.fetchShipmentFull(token, shipId)
        if (sh) {
          // Mesclamos os campos diretamente no `order.shipping` antes do
          // buildOrderRows. raw_data.shipping vai ser populado a partir
          // desses campos. Mantém o tipo loose porque MlOrder.shipping
          // só tipa { id, status, logistic_type }.
          const shipObj = order.shipping as unknown as Record<string, unknown>
          shipObj.status                  = sh.status        ?? shipObj.status        ?? null
          shipObj.substatus               = sh.substatus     ?? shipObj.substatus     ?? null
          shipObj.logistic_type           = sh.logistic_type ?? shipObj.logistic_type ?? null
          shipObj.receiver_address        = sh.receiver_address  ?? shipObj.receiver_address  ?? null
          shipObj.estimated_delivery_date = sh.estimated_delivery_date ?? shipObj.estimated_delivery_date ?? null
          shipObj.posting_deadline        = sh.posting_deadline        ?? shipObj.posting_deadline        ?? null
          shipObj.date_created            = sh.date_created            ?? shipObj.date_created            ?? null
          shipObj.date_shipped            = sh.date_shipped            ?? shipObj.date_shipped            ?? null
        }
      } catch { /* best-effort */ }
    }

    // 3. Listing map (cache reuse — buildListingMap só dura essa execução)
    const listingMap = await this.buildListingMap(orgId)

    // 4. Buyer billing
    const stats: IngestionStats = { ordersFound: 1, rowsUpserted: 0, apiCalls: 0, errors: [] }
    const buyerMap = await this.fetchBuyersForOrders([order], token, stats)

    // 5. Build rows + upsert (com breakdown de frete)
    const rows = this.buildOrderRows(orgId, [order], costMap, listingMap, sellerId, buyerMap, breakdownMap)
    if (rows.length === 0) {
      return { upserted: 0, skipped: true, reason: 'no_rows_built' }
    }

    const { error } = await supabaseAdmin
      .from('orders')
      .upsert(rows, { onConflict: 'source,external_order_id,sku', ignoreDuplicates: false })

    if (error) {
      this.logger.error(`[single-ingest] upsert ${externalOrderId} falhou: ${error.message}`)
      return { upserted: 0, skipped: true, reason: `upsert_error:${error.message.slice(0, 100)}` }
    }

    this.logger.log(`[single-ingest] order=${externalOrderId} org=${orgId.slice(0,8)} upserted=${rows.length} em ${Date.now() - t0}ms`)

    // Dispara notificação rica pra UI (fire-and-forget — não atrasa webhook).
    // Só pra pedidos pagos. Falha silenciosa se algum dado faltar.
    if (order.status === 'paid') {
      this.newSaleNotifier.fireAndForget(orgId, sellerId, externalOrderId)
      // F12 Sprint 1 — auto-ingestão pro fulfillment (best-effort, gated por org)
      void this.fulfillment.autoIngestMarketplaceOrder(orgId, String(externalOrderId))
    }

    // Baixa de estoque (Estoque Unificado F3): venda paga decrementa o
    // ledger, cancelamento estorna. Idempotente via stock_movements, então
    // re-ingestão é segura. Agrega por produto (um pedido pode ter 2 linhas
    // do mesmo produto). Fire-and-forget — não atrasa o webhook.
    const saleByProduct = new Map<string, number>()
    for (const row of rows) {
      const pid = row.product_id as string | null
      if (!pid) continue
      saleByProduct.set(pid, (saleByProduct.get(pid) ?? 0) + (Number(row.quantity) || 0))
    }
    for (const [productId, quantity] of saleByProduct) {
      this.stock.applySaleMovement({
        productId,
        quantity,
        externalOrderId: String(externalOrderId),
        status:          String(order.status ?? ''),
        channel:         'mercadolivre',
      }).catch(e => this.logger.warn(`[single-ingest] baixa estoque produto=${productId}: ${(e as Error)?.message}`))
    }

    return { upserted: rows.length, skipped: false }
  }

  async ingestDateRange(
    orgId: string,
    dateFrom: string, // YYYY-MM-DD
    dateTo: string,   // YYYY-MM-DD
    runId: string,
  ): Promise<IngestionStats> {
    const t0 = Date.now()

    // CRITICAL: itera TODAS as contas ML conectadas da org. Antes pegava
    // só a com updated_at mais recente (getTokenForOrg sem sellerId), o
    // que fazia o aggregator ignorar pedidos das outras contas em orgs
    // multi-conta. Resultado pré-fix: a tela /pedidos parava de receber
    // pedidos da conta principal quando uma conta secundária era
    // conectada/atualizada depois.
    const tokens = await this.mlClient.getAllTokensForOrg(orgId)
    if (tokens.length === 0) {
      throw new Error('Nenhuma conta ML conectada nesta organização')
    }

    // Build listing→product lookup map for this org (once, upfront)
    const listingMap = await this.buildListingMap(orgId)

    const dates = this.buildDateRange(dateFrom, dateTo)
    const stats: IngestionStats = { ordersFound: 0, rowsUpserted: 0, apiCalls: 0, errors: [] }

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i]
      // Update current processing date (1 vez por data, antes do fan-out de contas)
      await supabaseAdmin
        .from('aggregator_runs')
        .update({ current_date_processing: date, processed_dates: i })
        .eq('id', runId)

      // Fan-out por conta — cada conta usa seu próprio token e sellerId
      for (const { token, sellerId } of tokens) {
        try {
          const { orders, apiCalls } = await this.mlClient.fetchOrdersByDateRange(token, sellerId, date, date)
          stats.apiCalls += apiCalls
          stats.ordersFound += orders.length

          if (orders.length === 0) continue

          // Fetch shipping costs E shipment FULL em paralelo (1 GET cada).
          // shipment full traz receiver_address (state/city) que /orders/search
          // NÃO devolve — sem isso o mapa "Vendas por Região" do dashboard
          // ficava zerado em pedidos ingeridos pelo aggregator. O webhook
          // já faz isso em ingestSingleOrder, mas o cron horário sobrescreve
          // o row no upsert; aqui restabelecemos a paridade.
          const shipIds = [...new Set(orders.map(o => o.shipping?.id).filter(Boolean))] as number[]
          const costMap = new Map<number, number>()
          const breakdownMap = new Map<number, { sender_cost: number; receiver_cost: number; gross_amount: number; ml_refund: number }>()
          const fullMap = new Map<number, Awaited<ReturnType<typeof this.mlClient.fetchShipmentFull>>>()
          if (shipIds.length > 0) {
            // fetchShipmentBreakdown chama o mesmo GET /shipments/{id}/costs
            // que fetchShipmentCost, mas devolve sender+receiver+gross+ml_refund
            // de uma vez. Derivamos costMap de sender_cost (= o que
            // fetchShipmentCost retornava) e ainda alimentamos breakdownMap pros
            // 3 campos de frete que o webhook já populava e o backfill não.
            const [breakdownResults, fullResults] = await Promise.all([
              Promise.allSettled(shipIds.map(id => this.mlClient.fetchShipmentBreakdown(token, id))),
              Promise.allSettled(shipIds.map(id => this.mlClient.fetchShipmentFull(token, id))),
            ])
            stats.apiCalls += shipIds.length * 2
            shipIds.forEach((id, idx) => {
              const b = breakdownResults[idx]
              if (b.status === 'fulfilled') {
                breakdownMap.set(id, b.value)
                costMap.set(id, b.value.sender_cost)
              } else {
                costMap.set(id, 0)
              }
              const f = fullResults[idx]
              fullMap.set(id, f.status === 'fulfilled' ? f.value : null)
            })
          }
          // Injeta dados do shipment full direto no order.shipping pra que
          // buildOrderRows os persista em raw_data.shipping. Reutiliza o
          // mesmo padrão do ingestSingleOrder.
          for (const o of orders) {
            const sid = o.shipping?.id
            if (!sid) continue
            const sh = fullMap.get(sid)
            if (!sh) continue
            const shipObj = o.shipping as unknown as Record<string, unknown>
            shipObj.status                  = sh.status        ?? shipObj.status        ?? null
            shipObj.substatus               = sh.substatus     ?? shipObj.substatus     ?? null
            shipObj.logistic_type           = sh.logistic_type ?? shipObj.logistic_type ?? null
            shipObj.receiver_address        = sh.receiver_address  ?? shipObj.receiver_address  ?? null
            shipObj.estimated_delivery_date = sh.estimated_delivery_date ?? shipObj.estimated_delivery_date ?? null
            shipObj.posting_deadline        = sh.posting_deadline        ?? shipObj.posting_deadline        ?? null
            shipObj.date_created            = sh.date_created            ?? shipObj.date_created            ?? null
          }

          // Fetch buyer billing for orders we haven't billed yet (CPF/email/phone).
          // Reuses any cached value already in DB so we never re-hit ML for the
          // same order. New orders get 1.1s pacing → no 429s on the billing
          // endpoint. The downstream sync_buyer_to_unified trigger fires per row.
          const buyerMap = await this.fetchBuyersForOrders(orders, token, stats)

          // Build rows for every order item
          const rows = this.buildOrderRows(orgId, orders, costMap, listingMap, sellerId, buyerMap, breakdownMap)

          if (rows.length > 0) {
            const BATCH = 100
            for (let b = 0; b < rows.length; b += BATCH) {
              const batch = rows.slice(b, b + BATCH)
              const { error } = await supabaseAdmin
                .from('orders')
                .upsert(batch, {
                  onConflict: 'source,external_order_id,sku',
                  ignoreDuplicates: false,
                })
              if (error) {
                console.error(`[aggregator] UPSERT FAILED on ${date} seller=${sellerId} batch ${b}:`, error.message)
                stats.errors.push({ date, error: `seller=${sellerId} upsert batch ${b}: ${error.message}` })
              } else {
                stats.rowsUpserted += batch.length
              }
            }
          }

          // Auto-trigger de jornadas (Messaging Studio) — best-effort.
          // Falha aqui não derruba a ingestion; engine de retry depende dos
          // próprios runs. 1 evento por order (não por row); status mapeado
          // pra trigger_event no MessagingService.statusToTrigger().
          try {
            const events = orders.map(o => {
              const buyer = buyerMap.get(String(o.id))
              const first = o.order_items?.[0]
              return {
                external_order_id: String(o.id),
                status:            o.status ?? null,
                buyer_phone:       buyer?.phone ?? null,
                buyer_name:        buyer?.name  ?? null,
                product_title:     first?.item?.title ?? null,
              }
            })
            await this.messaging.fireForOrderEvents(orgId, events)
          } catch (err: unknown) {
            this.logger.warn(`[messaging.trigger] hook falhou: ${(err as Error)?.message}`)
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[aggregator] error on ${date} seller=${sellerId}:`, msg)
          stats.errors.push({ date, error: `seller=${sellerId}: ${msg}` })
        }
      }

      // Update run stats — após processar todas as contas dessa data
      await supabaseAdmin
        .from('aggregator_runs')
        .update({
          processed_dates: i + 1,
          orders_fetched: stats.ordersFound,
          orders_inserted: stats.rowsUpserted,
          api_calls_made: stats.apiCalls,
        })
        .eq('id', runId)
    }

    // Consolidated final summary + persist for /sync-stats endpoint
    const withCpf = await this.countCpfFromBatch(stats).catch(() => 0)
    const duration = Date.now() - t0
    this.lastStats = {
      at:               new Date().toISOString(),
      orders_processed: stats.ordersFound,
      with_cpf:         withCpf,
      failed:           stats.errors.length,
      duplicates:       Math.max(0, stats.ordersFound - stats.rowsUpserted),
      duration_ms:      duration,
    }
    this.logger.log(
      `[ml-sync] ${stats.ordersFound} novos orders processados, ${withCpf} com CPF, ${stats.errors.length} sem CPF (billing falhou), ${this.lastStats.duplicates} duplicados (skip) — ${Math.round(duration/1000)}s`,
    )

    return stats
  }

  /** Enriquece pedidos com shipping_status / logistic_type via /shipments/{id}.
   *  ML não devolve esses campos em /orders/search — só em /shipments/{id}.
   *  Sem isso: tabs "Em Preparação" / "Despachadas" / "Encerradas" /
   *  "Flex" e KPIs "pendentes envio" / "em trânsito" ficam sempre zero.
   *
   *  Estratégia: pega N pedidos mais recentes com shipping_id mas sem
   *  shipping_status, agrupa por seller_id (token correto pra cada
   *  conta), chama /shipments/{id} com pacing 1.5s entre chamadas, faz
   *  UPDATE individual. Idempotente. */
  async enrichShippingStatuses(
    orgId: string,
    options: { limit?: number; daysBack?: number } = {},
  ): Promise<{ checked: number; updated: number; skipped: number }> {
    const limit    = Math.min(Math.max(options.limit ?? 200, 1), 1000)
    const daysBack = Math.max(options.daysBack ?? 30, 1)
    const fromIso  = new Date(Date.now() - daysBack * 86400_000).toISOString()

    const { data: rows } = await supabaseAdmin
      .from('orders')
      .select('id, seller_id, shipping_id, external_order_id, raw_data')
      .eq('organization_id', orgId)
      .not('shipping_id', 'is', null)
      .is('shipping_status', null)
      .gte('sold_at', fromIso)
      .neq('status', 'cancelled')
      .order('sold_at', { ascending: false })
      .limit(limit)

    if (!rows || rows.length === 0) return { checked: 0, updated: 0, skipped: 0 }

    // Agrupa por seller_id pra usar token correto de cada conta
    type Row = { id: string; seller_id: number; shipping_id: number; external_order_id: string; raw_data: Record<string, unknown> | null }
    const bySeller = new Map<number, Row[]>()
    for (const r of rows as Row[]) {
      if (!r.seller_id || !r.shipping_id) continue
      if (!bySeller.has(r.seller_id)) bySeller.set(r.seller_id, [])
      bySeller.get(r.seller_id)!.push(r)
    }

    let updated = 0
    let skipped = 0
    let checked = 0

    for (const [sellerId, batch] of bySeller) {
      let token: string
      try {
        ({ token } = await this.mlClient.getTokenForOrg(orgId, sellerId))
      } catch (e) {
        this.logger.warn(`[enrich-shipping] org=${orgId.slice(0,8)} seller=${sellerId} sem token: ${(e as Error).message}`)
        skipped += batch.length
        continue
      }

      for (const r of batch) {
        checked++
        // Usa fetchShipmentFull — pega status + substatus + logistic_type +
        // receiver_address de uma vez. Antes era fetchShipment (3 campos),
        // mas isso deixava endereço de fora e quebrava o mapa "Vendas por
        // Região" do dashboard. Custa o mesmo (1 GET /shipments/{id}).
        const shipment = await this.mlClient.fetchShipmentFull(token, r.shipping_id)
        if (!shipment) { skipped++; continue }

        // Mescla os campos novos no raw_data.shipping preservando o resto
        const raw = (r.raw_data ?? {}) as Record<string, unknown>
        const existingShipping = (raw.shipping as Record<string, unknown> | undefined) ?? {}
        const newRawData = {
          ...raw,
          shipping: {
            ...existingShipping,
            status:           shipment.status,
            substatus:        shipment.substatus,
            logistic_type:    shipment.logistic_type,
            receiver_address: shipment.receiver_address ?? existingShipping.receiver_address ?? null,
            estimated_delivery_date: shipment.estimated_delivery_date ?? existingShipping.estimated_delivery_date ?? null,
            posting_deadline:        shipment.posting_deadline        ?? existingShipping.posting_deadline        ?? null,
            date_created:            shipment.date_created            ?? existingShipping.date_created            ?? null,
            date_shipped:            shipment.date_shipped            ?? existingShipping.date_shipped            ?? null,
          },
        }

        const { error: upErr } = await supabaseAdmin
          .from('orders')
          .update({
            shipping_status: shipment.status,
            shipped_at:      (shipment.date_shipped as string | null) ?? null,
            raw_data:        newRawData,
          })
          .eq('id', r.id)

        if (upErr) {
          this.logger.warn(`[enrich-shipping] update ${r.external_order_id}: ${upErr.message}`)
          skipped++
          continue
        }

        updated++
        // Pacing pra evitar 429 — ML aceita ~5 req/s por token; 200ms = 5 req/s
        await new Promise(res => setTimeout(res, 200))
      }
    }

    this.logger.log(`[enrich-shipping] org=${orgId.slice(0,8)} checked=${checked} updated=${updated} skipped=${skipped}`)
    return { checked, updated, skipped }
  }

  /** Backfill direcionado pra `receiver_address`. Diferente de
   *  `enrichShippingStatuses` que filtra por `shipping_status IS NULL`,
   *  aqui pegamos pedidos que JÁ têm status mas estão sem endereço — o
   *  caso clássico do webhook orders_v2: ML retorna `shipping: {id}` em
   *  /orders/{id} sem o endereço, status vem depois via shipments e
   *  endereço fica nunca. Resultado: mapa "Vendas por Região" zerado em
   *  todos os pedidos novos.
   *
   *  Filtro: shipping_id NOT NULL, sold_at >= now() - daysBack,
   *  status != cancelled, raw_data->shipping->>receiver_address IS NULL.
   *  Usa fetchShipmentFull (que devolve endereço + status) e faz merge
   *  preservando os campos existentes em raw_data.shipping. */
  async enrichShippingAddresses(
    orgId: string,
    options: { limit?: number; daysBack?: number } = {},
  ): Promise<{ checked: number; updated: number; skipped: number }> {
    const limit    = Math.min(Math.max(options.limit ?? 200, 1), 1000)
    const daysBack = Math.max(options.daysBack ?? 30, 1)
    const fromIso  = new Date(Date.now() - daysBack * 86400_000).toISOString()

    // Filtro: pega TODOS os pedidos com shipping_id no período e
    // filtra em JS pelos que estão sem `state` em receiver_address.
    // Detalhe: PostgREST `.is('jsonpath', null)` NÃO catches JSON null
    // (só SQL null) — se a coluna tem o valor JSON `null` literal, o
    // filtro do PostgREST passa direto. Como o webhook orders_v2 grava
    // `receiver_address: null` (JSON null), precisamos filtrar em JS.
    const { data: rows, error: selErr } = await supabaseAdmin
      .from('orders')
      .select('id, seller_id, shipping_id, external_order_id, raw_data')
      .eq('organization_id', orgId)
      .not('shipping_id', 'is', null)
      .gte('sold_at', fromIso)
      .neq('status', 'cancelled')
      .order('sold_at', { ascending: false })
      .limit(Math.max(limit * 5, 1000)) // pega mais; filtra em JS

    if (selErr) {
      this.logger.error(`[enrich-address] select falhou: ${selErr.message}`)
      return { checked: 0, updated: 0, skipped: 0 }
    }
    if (!rows || rows.length === 0) return { checked: 0, updated: 0, skipped: 0 }

    type Row = { id: string; seller_id: number; shipping_id: number; external_order_id: string; raw_data: Record<string, unknown> | null }
    const needsAddress = (r: Row): boolean => {
      const ship = (r.raw_data?.shipping as Record<string, unknown> | undefined) ?? null
      const recv = ship?.receiver_address as Record<string, unknown> | null | undefined
      if (!recv) return true
      const state = (recv.state as { name?: string } | string | null | undefined)
      if (!state) return true
      if (typeof state === 'string') return state.trim() === ''
      return !state.name
    }
    const filtered = (rows as Row[]).filter(needsAddress).slice(0, limit)
    if (filtered.length === 0) return { checked: 0, updated: 0, skipped: 0 }

    const bySeller = new Map<number, Row[]>()
    for (const r of filtered) {
      if (!r.seller_id || !r.shipping_id) continue
      if (!bySeller.has(r.seller_id)) bySeller.set(r.seller_id, [])
      bySeller.get(r.seller_id)!.push(r)
    }

    let updated = 0
    let skipped = 0
    let checked = 0

    for (const [sellerId, batch] of bySeller) {
      let token: string
      try {
        ({ token } = await this.mlClient.getTokenForOrg(orgId, sellerId))
      } catch (e) {
        this.logger.warn(`[enrich-address] org=${orgId.slice(0,8)} seller=${sellerId} sem token: ${(e as Error).message}`)
        skipped += batch.length
        continue
      }

      for (const r of batch) {
        checked++
        const shipment = await this.mlClient.fetchShipmentFull(token, r.shipping_id)
        if (!shipment || !shipment.receiver_address) { skipped++; continue }

        const raw = (r.raw_data ?? {}) as Record<string, unknown>
        const existingShipping = (raw.shipping as Record<string, unknown> | undefined) ?? {}
        const newRawData = {
          ...raw,
          shipping: {
            ...existingShipping,
            status:           shipment.status        ?? existingShipping.status        ?? null,
            substatus:        shipment.substatus     ?? existingShipping.substatus     ?? null,
            logistic_type:    shipment.logistic_type ?? existingShipping.logistic_type ?? null,
            receiver_address: shipment.receiver_address,
            estimated_delivery_date: shipment.estimated_delivery_date ?? existingShipping.estimated_delivery_date ?? null,
            posting_deadline:        shipment.posting_deadline        ?? existingShipping.posting_deadline        ?? null,
            date_created:            shipment.date_created            ?? existingShipping.date_created            ?? null,
            date_shipped:            shipment.date_shipped            ?? existingShipping.date_shipped            ?? null,
          },
        }

        const updatePayload: Record<string, unknown> = { raw_data: newRawData }
        if (shipment.status) updatePayload.shipping_status = shipment.status
        if (shipment.date_shipped) updatePayload.shipped_at = shipment.date_shipped

        const { error: upErr } = await supabaseAdmin
          .from('orders')
          .update(updatePayload)
          .eq('id', r.id)

        if (upErr) {
          this.logger.warn(`[enrich-address] update ${r.external_order_id}: ${upErr.message}`)
          skipped++
          continue
        }

        updated++
        await new Promise(res => setTimeout(res, 200))
      }
    }

    this.logger.log(`[enrich-address] org=${orgId.slice(0,8)} checked=${checked} updated=${updated} skipped=${skipped}`)
    return { checked, updated, skipped }
  }

  /** Counts how many orders ingested in this run ended up with CPF —
   * derived from the DB after upsert finishes. */
  private async countCpfFromBatch(_stats: IngestionStats): Promise<number> {
    const { count } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .not('buyer_doc_number', 'is', null)
      .gte('updated_at', new Date(Date.now() - 10 * 60_000).toISOString()) // últimos 10 min
    return count ?? 0
  }

  /** For every order in this batch, return the buyer info we'll attach to
   * each row. Reads existing rows from `orders` first so already-fetched
   * orders don't re-hit ML; new ones are fetched serially with 1.1s pacing.
   * On any failure we still stamp `buyer_billing_fetched_at = now()` so the
   * row is treated as "tried" and not retried by the manual top-up button.
   *
   * IMPORTANTE — Preservação de CPF: o worker faz UPSERT FULL no upsert
   * de orders, então `buyer_doc_number: snapshot.doc_number ?? null`
   * sobrescreve a coluna toda vez. Pra NUNCA apagar CPF bom:
   *
   *   1. SEMPRE lê existing data primeiro (sem filtro fetched_at)
   *   2. Pedidos COM fetched_at → reutiliza snapshot bom (skip ML fetch)
   *   3. Pedidos SEM fetched_at mas COM doc_number existente → re-fetch
   *      mas mescla com existing como fallback (se ML não devolver CPF,
   *      mantém o que já tinha)
   *   4. Pedidos novos → fetch limpo
   *
   * Token único é cross-conta-incompatível: pedido de outra conta da org
   * retorna 401/403. A camada de ingestão precisaria fan-out, mas como
   * isso é mais invasivo, a solução defensive aqui evita o pior caso
   * (perda de CPF). Refetch manual via /refetch-billing já tem fan-out. */
  private async fetchBuyersForOrders(
    orders: MlOrder[],
    token: string,
    stats: IngestionStats,
  ): Promise<Map<string, BuyerSnapshot>> {
    const out = new Map<string, BuyerSnapshot>()
    if (orders.length === 0) return out

    const externalIds = [...new Set(orders.map(o => String(o.id)))]

    // 1. Lê TODAS as rows existentes (sem filtro fetched_at) — fonte de
    //    fallback pra preservar CPF/phone/billing_address bom mesmo
    //    quando ML re-fetch falha.
    const { data: existing } = await supabaseAdmin
      .from('orders')
      .select(
        'external_order_id, buyer_doc_type, buyer_doc_number, buyer_email, buyer_phone, buyer_name, buyer_last_name, buyer_billing_info_id, billing_address, billing_country, buyer_billing_fetched_at',
      )
      .in('external_order_id', externalIds)

    const existingByOrder = new Map<string, BuyerSnapshot>()
    for (const row of existing ?? []) {
      existingByOrder.set(row.external_order_id as string, {
        doc_type:        (row.buyer_doc_type       as string | null) ?? null,
        doc_number:      (row.buyer_doc_number     as string | null) ?? null,
        email:           (row.buyer_email          as string | null) ?? null,
        phone:           (row.buyer_phone          as string | null) ?? null,
        name:            (row.buyer_name           as string | null) ?? null,
        last_name:       (row.buyer_last_name      as string | null) ?? null,
        billing_info_id: (row.buyer_billing_info_id as string | null) ?? null,
        billing_address: (row.billing_address      as Record<string, unknown> | null) ?? null,
        billing_country: (row.billing_country      as string | null) ?? null,
        fetched_at:      (row.buyer_billing_fetched_at as string | null) ?? null,
      })
    }

    // 2. Pedidos COM fetched_at já set → reutiliza (skip ML). Mantém o
    //    comportamento de cache que já tinha.
    for (const [id, snap] of existingByOrder) {
      if (snap.fetched_at) out.set(id, snap)
    }

    // 3. Pedidos sem fetched_at — vão pro ML cascade. Mas guardamos o
    //    existing snapshot pra mesclar como fallback após o fetch.
    const toFetch = externalIds.filter(id => !out.has(id))
    if (toFetch.length === 0) return out

    const buyerIdByOrder = new Map<string, number | null>()
    for (const o of orders) buyerIdByOrder.set(String(o.id), o.buyer?.id ?? null)

    let withCpf = 0, withPhone = 0, miss = 0, failed = 0

    // Process billing in parallel batches — 3 paralelos × ~3 req/s sustentado.
    // ML aceita ~10 req/s; manter em 3 deixa margem segura sem 429s.
    for (let i = 0; i < toFetch.length; i += BILLING_BATCH) {
      const batch = toFetch.slice(i, i + BILLING_BATCH)
      const settled = await Promise.allSettled(batch.map(async (id) => {
        const buyerId = buyerIdByOrder.get(id) ?? null
        return await this.resolveOneBuyer(id, buyerId, token, stats)
      }))

      for (let j = 0; j < settled.length; j++) {
        const id = batch[j]
        const r  = settled[j]
        const prev = existingByOrder.get(id) // existing CPF/phone/etc se houver
        if (r.status === 'fulfilled') {
          const { snapshot, hasCpf, hasPhone } = r.value
          // Merge defensivo: ML novo > existing > null. Se ML não devolveu
          // CPF mas existing tinha, preserva existing. Mesma coisa pra
          // phone/billing_address/etc. Resolve cross-conta sem precisar
          // fan-out aqui — basta nunca regredir.
          out.set(id, {
            doc_type:        snapshot.doc_type        ?? prev?.doc_type        ?? null,
            doc_number:      snapshot.doc_number      ?? prev?.doc_number      ?? null,
            email:           snapshot.email           ?? prev?.email           ?? null,
            phone:           snapshot.phone           ?? prev?.phone           ?? null,
            name:            snapshot.name            ?? prev?.name            ?? null,
            last_name:       snapshot.last_name       ?? prev?.last_name       ?? null,
            billing_info_id: snapshot.billing_info_id ?? prev?.billing_info_id ?? null,
            billing_address: snapshot.billing_address ?? prev?.billing_address ?? null,
            billing_country: snapshot.billing_country ?? prev?.billing_country ?? null,
            fetched_at:      snapshot.fetched_at      ?? new Date().toISOString(),
          })
          if (hasCpf || prev?.doc_number) withCpf++
          else                            miss++
          if (hasPhone || prev?.phone)    withPhone++
        } else {
          // Falha total — preserva existing se houver, senão grava null com
          // fetched_at=null pra cron horário tentar de novo
          failed++
          this.logger.warn(`[ml-sync.billing.failed] order=${id} ${(r.reason as Error)?.message ?? 'erro'}`)
          out.set(id, prev ?? {
            doc_type: null, doc_number: null, email: null, phone: null,
            name: null, last_name: null, billing_info_id: null,
            billing_address: null, billing_country: null,
            fetched_at: null,
          })
        }
      }

      // 1s entre batches → mantém 3 req/s sustentado sem 429
      if (i + BILLING_BATCH < toFetch.length) {
        await new Promise(r => setTimeout(r, BILLING_BATCH_GAP))
      }
    }

    this.logger.log(
      `[aggregator.billing] fetched=${toFetch.length} cpf=${withCpf} phone=${withPhone} no_data=${miss} failed=${failed}`,
    )
    return out
  }

  /** Single-order billing resolution. Throws on hard failure so the
   * caller's Promise.allSettled tracks it as `failed` — fetched_at stays
   * null so the hourly cron can retry. */
  private async resolveOneBuyer(
    id: string,
    buyerId: number | null,
    token: string,
    stats: IngestionStats,
  ): Promise<{ snapshot: BuyerSnapshot; hasCpf: boolean; hasPhone: boolean }> {
    const result = await this.mlClient.fetchCompleteBillingForOrder(token, id)
    stats.apiCalls += 2 // 1 GET /orders + 1 billing-info (média; legado +1)

    const billing = result.billing
    const docNumber = billing?.identification?.number ?? billing?.doc_number ?? null
    const docType   = billing?.identification?.type   ?? billing?.doc_type   ?? null
    const cleanDoc  = docNumber ? docNumber.replace(/\D/g, '') || null : null

    let userInfo: Awaited<ReturnType<typeof this.mlClient.fetchBuyerUser>> = null
    if (buyerId && !cleanDoc) {
      userInfo = await this.mlClient.fetchBuyerUser(token, buyerId)
      stats.apiCalls++
    }

    const composedFromBilling = [billing?.name, billing?.last_name].filter(Boolean).join(' ').trim() || null
    const composedFromUser    = [userInfo?.first_name, userInfo?.last_name].filter(Boolean).join(' ').trim() || null
    const name  = composedFromBilling ?? composedFromUser ?? null
    const phone = userInfo?.phone ?? null

    const snapshot: BuyerSnapshot = {
      doc_type:        docType,
      doc_number:      cleanDoc,
      email:           null, // ML não fornece (LGPD)
      phone,
      name,
      last_name:       billing?.last_name ?? userInfo?.last_name ?? null,
      billing_info_id: result.billingInfoId,
      billing_address: (billing?.address ?? null) as Record<string, unknown> | null,
      billing_country: billing?.address?.country_id ?? 'BR',
      fetched_at:      new Date().toISOString(),
    }

    if (cleanDoc) {
      this.logger.log(`[ml-sync.billing.ok] order=${id} cpf=yes log=${result.log.join('|')}`)
    } else {
      this.logger.log(`[ml-sync.billing.no_cpf] order=${id} log=${result.log.join('|')}`)
    }

    return { snapshot, hasCpf: !!cleanDoc, hasPhone: !!phone }
  }

  private buildOrderRows(
    orgId: string,
    orders: MlOrder[],
    costMap: Map<number, number>,
    listingMap: Map<string, ProductInfo>,
    sellerId: number,
    buyerMap: Map<string, BuyerSnapshot> = new Map(),
    breakdownMap: Map<number, { sender_cost: number; receiver_cost: number; gross_amount: number; ml_refund: number }> = new Map(),
  ): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = []
    const now = new Date().toISOString()

    for (const order of orders) {
      const orderShippingCost = order.shipping?.id ? (costMap.get(order.shipping.id) ?? 0) : 0
      const shipBreakdown     = order.shipping?.id ? breakdownMap.get(order.shipping.id) : undefined
      const orderTotal = order.total_amount ?? 1
      const buyer = buyerMap.get(String(order.id))
      // Buyer name fallback: billing name → first+last → nickname
      const buyerNameFallback =
        buyer?.name ??
        ([order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(' ').trim() || null) ??
        order.buyer?.nickname ??
        null

      for (const item of order.order_items ?? []) {
        const listingId = item.item?.id ?? ''
        const sku = item.item?.seller_sku ?? listingId
        const qty = item.quantity ?? 1
        const unitPrice = item.unit_price ?? 0
        const itemTotal = qty * unitPrice

        // Proportional shipping allocation
        const shippingAlloc = orderTotal > 0 ? orderShippingCost * (itemTotal / orderTotal) : 0

        const prod = listingMap.get(listingId)
        const costPriceTotal = prod?.cost_price != null ? prod.cost_price * qty : null
        const taxOnFreight = prod?.tax_on_freight ?? false
        const taxBase = taxOnFreight ? itemTotal + shippingAlloc : itemTotal
        const taxAmount = prod?.tax_percentage != null ? taxBase * (prod.tax_percentage / 100) : null

        const saleFee = item.sale_fee ?? 0
        const grossProfit = itemTotal - saleFee - shippingAlloc
        const cm = costPriceTotal != null
          ? grossProfit - costPriceTotal - (taxAmount ?? 0)
          : null
        const cmPct = cm != null && itemTotal > 0 ? cm / itemTotal * 100 : null

        const soldAt = order.date_closed ?? order.date_created

        // Aloca breakdown do frete proporcional ao item (mesmo critério
        // do shippingCost). Cada componente é split pelo peso do item.
        const splitRatio = orderTotal > 0 ? (itemTotal / orderTotal) : 0
        const buyerPaidAlloc  = (shipBreakdown?.receiver_cost ?? 0) * splitRatio
        const mlRefundAlloc   = (shipBreakdown?.ml_refund     ?? 0) * splitRatio
        const grossAlloc      = (shipBreakdown?.gross_amount  ?? 0) * splitRatio

        rows.push({
          organization_id:         orgId,
          source:                  'mercadolivre',
          platform:                'mercadolivre',
          seller_id:               sellerId,
          external_order_id:       String(order.id),
          marketplace_listing_id:  listingId,
          product_id:              prod?.product_id ?? null,
          product_title:           item.item?.title ?? null,
          sku,
          quantity:                qty,
          sale_price:              unitPrice,
          platform_fee:            Math.round(saleFee * 100) / 100,
          shipping_cost:           Math.round(shippingAlloc * 100) / 100,
          shipping_buyer_paid:     Math.round(buyerPaidAlloc * 100) / 100,
          shipping_ml_refund:      Math.round(mlRefundAlloc * 100) / 100,
          shipping_gross:          Math.round(grossAlloc * 100) / 100,
          cost_price:              costPriceTotal != null ? Math.round(costPriceTotal * 100) / 100 : null,
          tax_amount:              taxAmount != null ? Math.round(taxAmount * 100) / 100 : null,
          gross_profit:            Math.round(grossProfit * 100) / 100,
          contribution_margin:     cm != null ? Math.round(cm * 100) / 100 : null,
          contribution_margin_pct: cmPct != null ? Math.round(cmPct * 100) / 100 : null,
          status:                  order.status,
          shipping_id:             order.shipping?.id      ?? null,
          shipping_status:         order.shipping?.status  ?? null,
          shipped_at:              ((order.shipping as Record<string, unknown> | undefined)?.date_shipped as string | null) ?? null,
          buyer_name:              buyerNameFallback,
          buyer_username:          order.buyer?.nickname ?? null,
          buyer_doc_type:          buyer?.doc_type        ?? null,
          buyer_doc_number:        buyer?.doc_number      ?? null,
          buyer_last_name:         buyer?.last_name       ?? null,
          buyer_billing_info_id:   buyer?.billing_info_id ?? null,
          buyer_email:             buyer?.email           ?? null, // never from ML — only enrichment fills this
          buyer_phone:             buyer?.phone           ?? null,
          billing_address:         buyer?.billing_address ?? null,
          billing_country:         buyer?.billing_country ?? 'BR',
          buyer_billing_fetched_at: buyer?.fetched_at     ?? null,
          sold_at:                 soldAt,
          raw_data: {
            order_id:      order.id,
            date_created:  order.date_created,
            date_closed:   order.date_closed,
            status:        order.status,
            status_detail: order.status_detail ?? null,
            total_amount:  order.total_amount,
            paid_amount:   order.paid_amount ?? null,
            pack_id:       (order as unknown as Record<string, unknown>).pack_id ?? null,
            coupon:        (order as unknown as Record<string, unknown>).coupon ?? null,
            context:       (order as unknown as Record<string, unknown>).context ?? null,
            item: {
              id:                   item.item?.id,
              title:                item.item?.title,
              seller_sku:           item.item?.seller_sku,
              variation_id:         item.item?.variation_id ?? null,
              variation_attributes: ((item.item as unknown) as Record<string, unknown>).variation_attributes ?? [],
              quantity:             item.quantity,
              unit_price:           item.unit_price,
              full_unit_price:      item.full_unit_price ?? item.unit_price,
              sale_fee:             item.sale_fee,
            },
            buyer: {
              id:         order.buyer?.id,
              nickname:   order.buyer?.nickname,
              first_name: order.buyer?.first_name ?? null,
              last_name:  order.buyer?.last_name  ?? null,
            },
            shipping: order.shipping
              ? {
                  id:             order.shipping.id,
                  status:         order.shipping.status        ?? null,
                  logistic_type:  order.shipping.logistic_type ?? null,
                  // Receiver address NÃO vem em /orders/search — só em
                  // /shipments/{id}. Por isso o mapper usa billing_address
                  // como fallback. Persistimos os campos disponíveis aqui
                  // mesmo, caso a ML evolua o endpoint.
                  receiver_cost:           (order.shipping as Record<string, unknown>).receiver_cost           ?? null,
                  estimated_delivery_date: (order.shipping as Record<string, unknown>).estimated_delivery_date ?? null,
                  posting_deadline:        (order.shipping as Record<string, unknown>).posting_deadline        ?? null,
                  date_created:            (order.shipping as Record<string, unknown>).date_created            ?? null,
                  date_shipped:            (order.shipping as Record<string, unknown>).date_shipped            ?? null,
                  substatus:               (order.shipping as Record<string, unknown>).substatus               ?? null,
                  receiver_address:        (order.shipping as Record<string, unknown>).receiver_address        ?? null,
                }
              : null,
            shipping_id: order.shipping?.id ?? null,
            // Persiste payments completo — frontend lê id/total_paid_amount/
            // installments/payment_type/status. Tipo "loose" pra não brigar
            // com a interface MlOrder que só tipa 2 campos.
            payments:    order.payments ?? [],
            mediations:  order.mediations ?? [],
            tags:        order.tags       ?? [],
          },
          updated_at: now,
        })
      }
    }

    return rows
  }

  private async buildListingMap(orgId: string): Promise<Map<string, ProductInfo>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id, product_id, products(cost_price, tax_percentage, tax_on_freight, sku)')
      .eq('platform', 'mercadolivre')
      .eq('is_active', true) as { data: Array<{
        listing_id: string
        product_id: string | null
        products: { cost_price: number | null; tax_percentage: number | null; tax_on_freight: boolean; sku: string | null } | null
      }> | null }

    const map = new Map<string, ProductInfo>()
    for (const row of data ?? []) {
      if (!row.product_id) continue
      const prod = Array.isArray(row.products)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (row.products as any[])[0]
        : row.products
      map.set(row.listing_id, {
        product_id:     row.product_id,
        cost_price:     prod?.cost_price ?? null,
        tax_percentage: prod?.tax_percentage ?? null,
        tax_on_freight: prod?.tax_on_freight ?? false,
        sku:            prod?.sku ?? null,
      })
    }
    return map
  }

  private buildDateRange(from: string, to: string): string[] {
    const dates: string[] = []
    const cur = new Date(from + 'T12:00:00Z')
    const end = new Date(to + 'T12:00:00Z')
    while (cur <= end) {
      dates.push(cur.toISOString().slice(0, 10))
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
    return dates
  }
}
