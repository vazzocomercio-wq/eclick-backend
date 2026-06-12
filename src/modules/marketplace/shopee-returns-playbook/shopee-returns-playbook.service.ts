import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from '../shopee-sync/shopee-product-sync.service'
import { LlmService } from '../../ai/llm.service'
import type { MpConnection } from '../adapters/base'

/** Playbook IA de Devoluções (Shopee) — pra cada devolução aberta, decide a
 *  melhor ação econômica e gera recomendação com racional:
 *
 *  1. REGRAS DETERMINÍSTICAS primeiro (auditáveis):
 *     - custo de recuperar o item (frete reverso + manuseio) ≥ valor
 *       recuperável (custo dos itens) → ACEITAR (brigar custa mais caro);
 *     - comprador alega NÃO RECEBEU mas o rastreio consta entregue →
 *       DISPUTAR com evidência de entrega;
 *  2. IA (LlmService, feature shopee_return_playbook) pros casos cinzas:
 *     classifica o texto do comprador (legítimo/suspeito/abuso) e estima a
 *     chance de ganhar disputa.
 *
 *  Persiste em colunas playbook_* do marketplace_returns (ADITIVAS — outra
 *  sessão usa a mesma tabela com prefixo sac_).
 *
 *  Execução (aceitar/disputar/aceitar oferta) = ESCRITA REAL na Shopee:
 *  copiloto (clique do user na tela, perm orders.refund). Modo AUTO é
 *  duplamente gated: env RETURN_PLAYBOOK=on + returns_playbook_config.enabled
 *  por org, e SÓ auto-aceita reembolso ≤ teto — disputa é sempre humana. */
@Injectable()
export class ShopeeReturnsPlaybookService {
  private readonly logger = new Logger(ShopeeReturnsPlaybookService.name)
  private static readonly OPEN_STATUSES = ['REQUESTED', 'PROCESSING', 'JUDGING']
  private static readonly AUTO_MIN_CONFIDENCE = 0.85

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly adapter:     ShopeeAdapter,
    private readonly productSync: ShopeeProductSyncService,
    private readonly llm:         LlmService,
  ) {}

  // ── config (Fase D — modo auto opt-in) ──────────────────────────────────

  async getConfig(orgId: string): Promise<{
    enabled: boolean; auto_accept_max_amount: number
    reverse_shipping_cost: number; handling_cost: number
  }> {
    const { data } = await supabaseAdmin
      .from('returns_playbook_config')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    return {
      enabled:                Boolean(data?.enabled),
      auto_accept_max_amount: Number(data?.auto_accept_max_amount ?? 0),
      reverse_shipping_cost:  Number(data?.reverse_shipping_cost ?? 20),
      handling_cost:          Number(data?.handling_cost ?? 5),
    }
  }

  async saveConfig(orgId: string, patch: {
    enabled?: boolean; auto_accept_max_amount?: number
    reverse_shipping_cost?: number; handling_cost?: number
  }): Promise<{ ok: true }> {
    const row: Record<string, unknown> = { organization_id: orgId, updated_at: new Date().toISOString() }
    if (patch.enabled                != null) row.enabled = Boolean(patch.enabled)
    if (patch.auto_accept_max_amount != null) row.auto_accept_max_amount = Math.max(0, Number(patch.auto_accept_max_amount) || 0)
    if (patch.reverse_shipping_cost  != null) row.reverse_shipping_cost  = Math.max(0, Number(patch.reverse_shipping_cost)  || 0)
    if (patch.handling_cost          != null) row.handling_cost          = Math.max(0, Number(patch.handling_cost)          || 0)
    const { error } = await supabaseAdmin
      .from('returns_playbook_config')
      .upsert(row, { onConflict: 'organization_id' })
    if (error) throw new BadRequestException(`Config do playbook: ${error.message}`)
    return { ok: true }
  }

  // ── motor de análise ─────────────────────────────────────────────────────

  /** Analisa todas as devoluções ABERTAS da org (gera/atualiza recomendação).
   *  force=true reanalisa mesmo as já processadas. */
  async analyzeAll(orgId: string, opts: { force?: boolean } = {}): Promise<{
    analyzed: number
    results:  Array<{ return_sn: string; action: string; confidence: number; error?: string }>
  }> {
    let q = supabaseAdmin
      .from('marketplace_returns')
      .select('*')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .in('status', ShopeeReturnsPlaybookService.OPEN_STATUSES)
      .order('return_update_at', { ascending: false })
      .limit(50)
    if (!opts.force) q = q.is('playbook_processed_at', null)
    const { data: rows, error } = await q
    if (error) throw new BadRequestException(`marketplace_returns: ${error.message}`)

    const results: Array<{ return_sn: string; action: string; confidence: number; error?: string }> = []
    for (const row of rows ?? []) {
      try {
        const rec = await this.analyzeOne(orgId, row)
        results.push({ return_sn: row.return_sn, action: rec.action, confidence: rec.confidence })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.logger.warn(`[returns.playbook] ${row.return_sn}: ${msg}`)
        results.push({ return_sn: row.return_sn, action: 'error', confidence: 0, error: msg })
      }
    }
    return { analyzed: results.filter(r => r.action !== 'error').length, results }
  }

  /** Analisa UMA devolução: detail live + economics + regras + IA → persiste. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async analyzeOne(orgId: string, row: any): Promise<{
    action: string; confidence: number; rationale: string
  }> {
    const cfg = await this.getConfig(orgId)
    const conn = await this.connForShop(orgId, row.shop_id)

    // detail live: negotiation/seller_proof/prazos vivem SÓ no detail
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let detail: any = null
    try {
      detail = await this.adapter.getReturnDetail(conn, row.return_sn)
    } catch (e) {
      this.logger.warn(`[returns.playbook] detail ${row.return_sn}: ${e instanceof Error ? e.message : e}`)
    }

    const economics = await this.computeEconomics(orgId, row, cfg)
    const negotiation = detail?.negotiation ?? null
    const rulesFired: string[] = []

    let action     = ''
    let confidence = 0
    let rationale  = ''

    // R1 — comprador diz que NÃO recebeu, mas o pedido consta entregue/concluído
    const claimsNotReceived = String(row.reason ?? '').startsWith('NOT_RECEIPT')
    if (claimsNotReceived && economics.order_delivered) {
      rulesFired.push('not_receipt_but_delivered')
      action     = 'dispute'
      confidence = 0.85
      rationale  = 'O comprador alega que não recebeu, mas o pedido consta como entregue no rastreio. Disputa com evidência de entrega tem alta chance de ganho.'
    }

    // R2 — recuperar o item custa mais do que ele vale → aceitar é a decisão econômica.
    // Só prefere a OFERTA pendente do comprador se ela custa MENOS OU IGUAL ao
    // reembolso normal (caso real: comprador ofereceu R$31,80 = item+frete contra
    // reembolso de R$23,80 — aceitar a oferta pagaria R$8 a mais).
    if (!action && row.needs_logistics && economics.recoverable_value != null
        && economics.recoverable_value <= economics.cost_to_recover) {
      rulesFired.push('recovery_costs_more_than_item')
      const refund = Number(row.refund_amount ?? 0)
      const offerAmount = negotiation?.negotiation_status === 'PENDING_RESPOND'
        ? Number(negotiation?.latest_offer_amount ?? NaN)
        : NaN
      const offerCheaper = Number.isFinite(offerAmount) && offerAmount <= refund
      action     = offerCheaper ? 'accept_offer' : 'accept'
      confidence = 0.9
      rationale  = `Receber o item de volta custa ~R$ ${economics.cost_to_recover.toFixed(2)} (frete reverso + manuseio) e o custo dos itens é R$ ${economics.recoverable_value.toFixed(2)} — brigar/recuperar sai mais caro que aceitar o reembolso de R$ ${refund.toFixed(2)}.`
      if (offerCheaper) {
        rationale += ` A oferta pendente do comprador (R$ ${offerAmount.toFixed(2)}) é menor/igual ao reembolso — aceitar a oferta sai mais barato.`
      } else if (Number.isFinite(offerAmount)) {
        rationale += ` ⚠️ Há uma oferta pendente do comprador de R$ ${offerAmount.toFixed(2)}, MAIOR que o reembolso — aceitar a devolução normal é mais barato que a oferta.`
      }
    }

    // Camada IA — casos cinzas (ou refina a regra com a fala/fotos do comprador)
    const ai = await this.classifyWithAi(orgId, row, detail, economics).catch(e => {
      this.logger.warn(`[returns.playbook] IA ${row.return_sn}: ${e instanceof Error ? e.message : e}`)
      return null
    })

    if (!action) {
      // sem regra dura: IA decide; fallback conservador = monitor
      action     = ai?.action ?? 'monitor'
      confidence = ai?.confidence ?? 0.4
      rationale  = ai?.rationale ?? 'Sem regra determinística aplicável e IA indisponível — seguir o fluxo padrão da Shopee (receber o item e validar).'
      if (ai) rulesFired.push('ai_decision')
    } else if (ai?.classification === 'abuse' && action !== 'dispute') {
      // regra econômica mandava aceitar, mas a IA viu sinais fortes de abuso →
      // rebaixa pra coleta de evidência (humano decide)
      rulesFired.push('ai_abuse_override')
      action     = 'collect_evidence'
      confidence = Math.min(confidence, 0.6)
      rationale += ` ⚠️ A IA viu sinais de possível abuso na solicitação (${ai.rationale}) — vale coletar evidência antes de aceitar.`
    }

    const meta = {
      economics,
      negotiation,
      rules_fired: rulesFired,
      ai: ai ?? null,
      detail_status: detail?.status ?? null,
      analyzed_with_config: { reverse_shipping_cost: cfg.reverse_shipping_cost, handling_cost: cfg.handling_cost },
    }

    const { error } = await supabaseAdmin
      .from('marketplace_returns')
      .update({
        playbook_action:       action,
        playbook_rationale:    rationale,
        playbook_confidence:   confidence,
        playbook_processed_at: new Date().toISOString(),
        playbook_meta:         meta,
        updated_at:            new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .eq('return_sn', row.return_sn)
    if (error) throw new Error(`persist playbook: ${error.message}`)

    return { action, confidence, rationale }
  }

  /** Economics: o que custa recuperar o item vs o que ele vale.
   *  - recoverable_value = Σ cost_price×qtd dos itens devolvidos (orders por SKU)
   *  - cost_to_recover   = frete reverso + manuseio (config da org)
   *  - order_delivered   = rastreio do pedido consta entregue/concluído */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async computeEconomics(orgId: string, row: any, cfg: {
    reverse_shipping_cost: number; handling_cost: number
  }): Promise<{
    refund_amount: number; recoverable_value: number | null; cost_to_recover: number
    order_delivered: boolean; order_statuses: string[]; items_matched: number
  }> {
    const refund = Number(row.refund_amount ?? 0)
    const costToRecover = cfg.reverse_shipping_cost + cfg.handling_cost

    if (!row.order_sn) {
      return { refund_amount: refund, recoverable_value: null, cost_to_recover: costToRecover, order_delivered: false, order_statuses: [], items_matched: 0 }
    }
    const { data: orderRows } = await supabaseAdmin
      .from('orders')
      .select('sku, quantity, cost_price, shipping_status, status')
      .eq('organization_id', orgId)
      .eq('source', 'shopee')
      .eq('external_order_id', String(row.order_sn))

    const rows = orderRows ?? []
    // itens devolvidos (raw.item[].item_sku) — se não casar, usa o pedido todo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const returnedSkus = new Set(((row.raw?.item ?? []) as any[]).map(i => String(i?.item_sku || i?.variation_sku || '')).filter(Boolean))
    const matched = returnedSkus.size ? rows.filter(r => returnedSkus.has(String(r.sku ?? ''))) : rows
    const base = matched.length ? matched : rows

    let recoverable: number | null = null
    if (base.length && base.some(r => r.cost_price != null)) {
      recoverable = base.reduce((acc, r) => acc + (Number(r.cost_price ?? 0) * Number(r.quantity ?? 1)), 0)
    }
    const statuses = [...new Set(rows.flatMap(r => [r.shipping_status, r.status]).filter(Boolean).map(String))]
    const delivered = statuses.some(s => ['delivered', 'completed', 'to_confirm_receive'].includes(s.toLowerCase()))

    return {
      refund_amount:     refund,
      recoverable_value: recoverable,
      cost_to_recover:   costToRecover,
      order_delivered:   delivered,
      order_statuses:    statuses,
      items_matched:     matched.length,
    }
  }

  /** IA: classifica a solicitação (legítima/suspeita/abuso) + chance de
   *  ganhar disputa + ação sugerida. jsonMode com parse defensivo. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async classifyWithAi(orgId: string, row: any, detail: any, economics: any): Promise<{
    action: string; confidence: number; classification: string
    dispute_win_probability: number; rationale: string
  } | null> {
    const photos = Array.isArray(detail?.image ?? row.raw?.image) ? (detail?.image ?? row.raw?.image).length : 0
    const videos = Array.isArray(detail?.buyer_videos ?? row.raw?.buyer_videos) ? (detail?.buyer_videos ?? row.raw?.buyer_videos).length : 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = ((detail?.item ?? row.raw?.item ?? []) as any[]).map(i => i?.name).filter(Boolean).slice(0, 3)

    const out = await this.llm.generateText({
      orgId,
      feature: 'shopee_return_playbook',
      systemPrompt:
        `Você é o analista de devoluções de um seller da Shopee Brasil. Avalie a solicitação e decida a ` +
        `melhor ação econômica pro vendedor, sendo justo com compradores legítimos. Ações possíveis: ` +
        `"accept" (aceitar devolução/reembolso — caso legítimo ou brigar custa mais), ` +
        `"accept_offer" (aceitar a oferta pendente do comprador — SÓ quando o valor da oferta é menor ou igual ao reembolso normal), ` +
        `"dispute" (disputar — só com evidência concreta e boa chance de ganho), ` +
        `"collect_evidence" (esperar o item chegar e documentar antes de decidir), ` +
        `"monitor" (fluxo padrão, sem ação especial). ` +
        `Sinais de abuso: texto genérico/incoerente com o motivo, motivo "defeito" sem foto, valor alto + ` +
        `histórico estranho, pedido de reembolso sem devolver. Disputa SÓ vale com evidência real. ` +
        `Responda APENAS JSON: {"action": "...", "confidence": 0.0-1.0, "classification": ` +
        `"legitimate"|"suspicious"|"abuse", "dispute_win_probability": 0.0-1.0, "rationale": ` +
        `"1-2 frases em PT-BR explicando pro lojista"}`,
      userPrompt: JSON.stringify({
        motivo:               row.reason,
        fala_do_comprador:    row.text_reason || '(sem texto)',
        valor_reembolso:      economics.refund_amount,
        custo_dos_itens:      economics.recoverable_value,
        custo_de_recuperar:   economics.cost_to_recover,
        pedido_entregue:      economics.order_delivered,
        precisa_logistica:    Boolean(row.needs_logistics),
        fotos_do_comprador:   photos,
        videos_do_comprador:  videos,
        itens:                items,
        negociacao:           detail?.negotiation ?? null,
        status:               row.status,
      }),
      jsonMode:  true,
      maxTokens: 400,
    })

    try {
      const j = JSON.parse(out.text.trim().replace(/^```json?\s*|```\s*$/g, ''))
      const valid = ['accept', 'accept_offer', 'dispute', 'collect_evidence', 'monitor']
      return {
        action:                  valid.includes(j.action) ? j.action : 'monitor',
        confidence:              Math.max(0, Math.min(1, Number(j.confidence) || 0.5)),
        classification:          ['legitimate', 'suspicious', 'abuse'].includes(j.classification) ? j.classification : 'legitimate',
        dispute_win_probability: Math.max(0, Math.min(1, Number(j.dispute_win_probability) || 0)),
        rationale:               String(j.rationale ?? '').slice(0, 600),
      }
    } catch {
      this.logger.warn(`[returns.playbook] IA devolveu não-JSON: ${out.text.slice(0, 200)}`)
      return null
    }
  }

  // ── dossiê (drawer da tela) ──────────────────────────────────────────────

  /** Dossiê live pro drawer: detail + soluções disponíveis + motivos de
   *  disputa válidos (com requisitos de evidência da própria Shopee). */
  async dossier(orgId: string, returnSn: string): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: any; detail: any; solutions: any; dispute_reasons: any[]
  }> {
    const row = await this.findReturn(orgId, returnSn)
    const conn = await this.connForShop(orgId, row.shop_id)
    const [detail, solutions, disputeReasons] = await Promise.all([
      this.adapter.getReturnDetail(conn, returnSn).catch(() => null),
      this.adapter.getReturnSolutions(conn, returnSn).catch(() => null),
      this.adapter.getReturnDisputeReasons(conn, returnSn).catch(() => []),
    ])
    return { row, detail, solutions, dispute_reasons: disputeReasons }
  }

  // ── execução (ESCRITA REAL na Shopee) ────────────────────────────────────

  /** ⚠️ Aceita a devolução/reembolso (confirm). Copiloto: clique do user. */
  async accept(orgId: string, returnSn: string, userId: string): Promise<{ ok: boolean; message: string }> {
    const row = await this.findReturn(orgId, returnSn)
    this.assertOpen(row)
    const conn = await this.connForShop(orgId, row.shop_id)
    const res = await this.adapter.confirmReturn(conn, returnSn)
    if (res?.error) throw new BadRequestException(`Shopee recusou o aceite: ${res.error} — ${res.message ?? ''}`)
    await this.markExecuted(orgId, returnSn, 'accept', userId)
    await this.refreshStatus(orgId, returnSn, conn)
    return { ok: true, message: 'Devolução aceita na Shopee.' }
  }

  /** ⚠️ Aceita a OFERTA pendente do comprador (negotiation). */
  async acceptOffer(orgId: string, returnSn: string, userId: string): Promise<{ ok: boolean; message: string }> {
    const row = await this.findReturn(orgId, returnSn)
    this.assertOpen(row)
    const conn = await this.connForShop(orgId, row.shop_id)
    const res = await this.adapter.acceptReturnOffer(conn, returnSn)
    if (res?.error) throw new BadRequestException(`Shopee recusou a oferta: ${res.error} — ${res.message ?? ''}`)
    await this.markExecuted(orgId, returnSn, 'accept_offer', userId)
    await this.refreshStatus(orgId, returnSn, conn)
    return { ok: true, message: 'Oferta do comprador aceita na Shopee.' }
  }

  /** ⚠️ Abre DISPUTA contra a devolução (sempre humana — nunca auto). */
  async dispute(orgId: string, returnSn: string, userId: string, opts: {
    disputeReason: number; text?: string; images?: string[]; email?: string
  }): Promise<{ ok: boolean; message: string }> {
    if (!Number.isFinite(opts.disputeReason)) throw new BadRequestException('disputeReason (código do motivo) é obrigatório')
    const row = await this.findReturn(orgId, returnSn)
    this.assertOpen(row)
    const conn = await this.connForShop(orgId, row.shop_id)
    const res = await this.adapter.disputeReturn(conn, returnSn, {
      disputeReason:     opts.disputeReason,
      disputeTextReason: opts.text,
      images:            opts.images,
      email:             opts.email,
    })
    if (res?.error) throw new BadRequestException(`Shopee recusou a disputa: ${res.error} — ${res.message ?? ''}`)
    await this.markExecuted(orgId, returnSn, 'dispute', userId)
    await this.refreshStatus(orgId, returnSn, conn)
    return { ok: true, message: 'Disputa aberta na Shopee.' }
  }

  // ── cron (análise contínua + modo AUTO opt-in) ──────────────────────────

  /** Gate env RETURN_PLAYBOOK=on. Analisa devoluções novas de todas as orgs;
   *  auto-aceita SÓ se a org ligou o modo auto (returns_playbook_config) e o
   *  reembolso está abaixo do teto. Disputa NUNCA é automática. */
  @Cron('25 */2 * * *', { name: 'shopee-returns-playbook' })
  async playbookTick(): Promise<void> {
    if (process.env.RETURN_PLAYBOOK !== 'on') return
    const { data: rows } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
    const orgIds = [...new Set((rows ?? []).map(r => r.organization_id as string))]
    for (const orgId of orgIds) {
      try {
        await this.analyzeAll(orgId)
        await this.autoExecute(orgId)
      } catch (e) {
        this.logger.warn(`[returns.playbook.cron] org=${orgId}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  /** Modo AUTO: executa SÓ aceite (accept/accept_offer) abaixo do teto, com
   *  confiança alta, em devolução ainda aberta e não executada. */
  private async autoExecute(orgId: string): Promise<void> {
    const cfg = await this.getConfig(orgId)
    if (!cfg.enabled || cfg.auto_accept_max_amount <= 0) return

    const { data: candidates } = await supabaseAdmin
      .from('marketplace_returns')
      .select('return_sn, refund_amount, playbook_action, playbook_confidence, shop_id')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .in('status', ShopeeReturnsPlaybookService.OPEN_STATUSES)
      .in('playbook_action', ['accept', 'accept_offer'])
      .is('playbook_executed_at', null)
      .gte('playbook_confidence', ShopeeReturnsPlaybookService.AUTO_MIN_CONFIDENCE)
      .lte('refund_amount', cfg.auto_accept_max_amount)
      .limit(5) // cap por ciclo — conservador
    for (const c of candidates ?? []) {
      try {
        if (c.playbook_action === 'accept_offer') await this.acceptOffer(orgId, c.return_sn, 'auto')
        else                                      await this.accept(orgId, c.return_sn, 'auto')
        this.logger.log(`[returns.playbook.auto] org=${orgId} ${c.return_sn} ${c.playbook_action} R$${c.refund_amount} executado`)
      } catch (e) {
        this.logger.warn(`[returns.playbook.auto] ${c.return_sn}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async findReturn(orgId: string, returnSn: string): Promise<any> {
    const { data, error } = await supabaseAdmin
      .from('marketplace_returns')
      .select('*')
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .eq('return_sn', returnSn)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data) throw new NotFoundException(`Devolução ${returnSn} não encontrada`)
    return data
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private assertOpen(row: any): void {
    if (!ShopeeReturnsPlaybookService.OPEN_STATUSES.includes(String(row.status))) {
      throw new BadRequestException(`Devolução já está em status ${row.status} — só dá pra agir em devolução aberta.`)
    }
  }

  private async connForShop(orgId: string, shopId: string | number | null): Promise<MpConnection> {
    if (!shopId) throw new BadRequestException('Devolução sem shop_id')
    const conn = await this.mp.getConnectionByShop(orgId, Number(shopId))
    if (!conn) throw new NotFoundException(`Loja Shopee ${shopId} não conectada`)
    return this.productSync.ensureFreshToken(conn)
  }

  private async markExecuted(orgId: string, returnSn: string, action: string, userId: string): Promise<void> {
    await supabaseAdmin
      .from('marketplace_returns')
      .update({
        playbook_executed_action: action,
        playbook_executed_at:     new Date().toISOString(),
        playbook_executed_by:     userId,
        updated_at:               new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('platform', 'shopee')
      .eq('return_sn', returnSn)
  }

  /** Pós-ação: relê o detail e atualiza o status local (sem esperar o cron). */
  private async refreshStatus(orgId: string, returnSn: string, conn: MpConnection): Promise<void> {
    try {
      const detail = await this.adapter.getReturnDetail(conn, returnSn)
      if (!detail?.status) return
      await supabaseAdmin
        .from('marketplace_returns')
        .update({
          status:           String(detail.status),
          return_update_at: detail.update_time ? new Date(detail.update_time * 1000).toISOString() : new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        })
        .eq('organization_id', orgId)
        .eq('platform', 'shopee')
        .eq('return_sn', returnSn)
    } catch (e) {
      this.logger.warn(`[returns.playbook] refresh ${returnSn}: ${e instanceof Error ? e.message : e}`)
    }
  }
}
