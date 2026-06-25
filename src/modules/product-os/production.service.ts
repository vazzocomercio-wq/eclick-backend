import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { StockService } from '../stock/stock.service'
import { ProductionInputService } from './production-input.service'

/**
 * Product OS — Fase 2: BOM detalhado, ordem de produção, fila de impressão e
 * qualidade. Reserva insumos ao enfileirar e, ao concluir, baixa insumos +
 * alimenta o estoque de produto acabado (Icarus) via StockService.
 */

const CHANNEL_ALLIN_FEE_PCT: Record<string, number> = {
  mercado_livre: 24.5, shopee: 31.6, tiktok: 8, loja: 0,
}

const ORDER_TRANSITIONS: Record<string, string[]> = {
  fila:        ['imprimindo', 'cancelado'],
  imprimindo:  ['pausado', 'falhou', 'acabamento', 'cancelado'],
  pausado:     ['imprimindo', 'cancelado'],
  falhou:      ['reimpressao', 'cancelado'],
  reimpressao: ['imprimindo', 'cancelado'],
  acabamento:  ['qualidade', 'cancelado'],
  qualidade:   ['embalado', 'falhou'],
  embalado:    ['disponivel'],
  disponivel:  [],
  cancelado:   [],
}

interface VersionMetrics { versionId: string | null; weight_g: number | null; print_time_minutes: number | null; material: string | null }

@Injectable()
export class ProductionService {
  private readonly logger = new Logger(ProductionService.name)

  constructor(
    private readonly stock: StockService,
    private readonly inputs: ProductionInputService,
  ) {}

  private round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }

  private async emit(orgId: string, devId: string, type: string, payload: Record<string, unknown>, userId?: string | null) {
    await supabaseAdmin.from('product_dev_event').insert({
      organization_id: orgId, product_dev_id: devId, event_type: type, payload, actor_id: userId ?? null,
    }).then(() => {}, () => {})
  }

  // ── BOM ───────────────────────────────────────────────────────────
  async getBom(orgId: string, devId: string, versionId?: string) {
    let q = supabaseAdmin.from('product_dev_bom').select('*')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('sort_order', { ascending: true })
    if (versionId) q = q.eq('version_id', versionId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async replaceBom(orgId: string, devId: string, userId: string | null, body: {
    version_id?: string
    lines: Array<{ kind: string; description?: string; input_id?: string; quantity: number; unit?: string; unit_cost?: number; waste_pct?: number; sort_order?: number }>
  }) {
    let del = supabaseAdmin.from('product_dev_bom').delete().eq('organization_id', orgId).eq('product_dev_id', devId)
    del = body.version_id ? del.eq('version_id', body.version_id) : del.is('version_id', null)
    await del
    const rows = (body.lines ?? []).map((l, idx) => ({
      organization_id: orgId, product_dev_id: devId, version_id: body.version_id ?? null,
      input_id: l.input_id ?? null, kind: l.kind, description: l.description ?? null,
      quantity: Number(l.quantity) || 0, unit: l.unit ?? 'un',
      unit_cost: Number(l.unit_cost) || 0, waste_pct: Number(l.waste_pct) || 0,
      sort_order: l.sort_order ?? idx, created_by: userId,
    }))
    if (rows.length) {
      const { error } = await supabaseAdmin.from('product_dev_bom').insert(rows)
      if (error) throw new BadRequestException(`Erro ao salvar BOM: ${error.message}`)
    }
    return this.getBom(orgId, devId, body.version_id)
  }

  async costFromBom(orgId: string, devId: string, body: { version_id?: string; target_margin_pct?: number } = {}) {
    const lines = await this.getBom(orgId, devId, body.version_id) as Array<{ quantity: number; unit_cost: number; waste_pct: number; input_id: string | null }>
    if (!lines.length) throw new BadRequestException('Sem BOM cadastrado. Cadastre os insumos ou use o custo estimado.')
    // puxa o custo médio ponderado VIVO dos insumos vinculados (WAC)
    const inputIds = lines.map(l => l.input_id).filter(Boolean) as string[]
    const costByInput = new Map<string, number>()
    if (inputIds.length) {
      const { data: inputs } = await supabaseAdmin.from('production_input').select('id, cost_per_unit').in('id', inputIds)
      for (const i of inputs ?? []) costByInput.set((i as { id: string }).id, Number((i as { cost_per_unit: number }).cost_per_unit) || 0)
    }
    const total = this.round2(lines.reduce((s, l) => {
      const unitCost = l.input_id && costByInput.has(l.input_id) ? (costByInput.get(l.input_id) as number) : Number(l.unit_cost)
      return s + Number(l.quantity) * unitCost * (1 + Number(l.waste_pct) / 100)
    }, 0))
    const targetMargin = Math.min(Math.max(Number(body.target_margin_pct ?? 30), 0), 90)
    const suggested = Object.entries(CHANNEL_ALLIN_FEE_PCT).map(([channel, fee]) => {
      const denom = 1 - fee / 100 - targetMargin / 100
      const price = denom > 0 ? this.round2(total / denom) : 0
      const marginPct = price > 0 ? this.round2(((price - price * fee / 100 - total) / price) * 100) : 0
      return { channel, fee_pct: fee, price, margin_pct: marginPct }
    })
    await supabaseAdmin.from('product_dev').update({ estimated_cost: total }).eq('id', devId).eq('organization_id', orgId)
    return { cost: { total, lines: lines.length }, target_margin_pct: targetMargin, suggested_prices: suggested }
  }

  // ── ordens de produção ────────────────────────────────────────────
  async listOrders(orgId: string, opts: { status?: string } = {}) {
    let q = supabaseAdmin.from('production_order').select('*')
      .eq('organization_id', orgId).order('created_at', { ascending: false })
    if (opts.status) q = q.eq('status', opts.status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async getOrder(orgId: string, oid: string) {
    const { data, error } = await supabaseAdmin.from('production_order').select('*')
      .eq('id', oid).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Ordem não encontrada')
    const { data: jobs } = await supabaseAdmin.from('print_job').select('*')
      .eq('production_order_id', oid).order('job_number', { ascending: true })
    return { ...data, jobs: jobs ?? [] }
  }

  /** Prévia do que uma OP vai CONSUMIR do estoque (BOM × qtd × (1+perda)), por insumo,
   *  com disponibilidade. NÃO grava nada. Fallback = filamento por peso se não há BOM. */
  async previewOrderConsumption(orgId: string, body: { product_dev_id: string; version_id?: string; quantity: number }) {
    const qty = Math.max(1, Math.floor(Number(body.quantity) || 0))
    const metrics = await this.resolveVersionMetrics(orgId, body.product_dev_id, body.version_id)
    const bom = await this.getBom(orgId, body.product_dev_id, body.version_id ?? metrics.versionId ?? undefined) as Array<{ input_id: string | null; quantity: number; waste_pct: number }>
    const needByInput = new Map<string, number>()
    for (const l of bom) {
      if (!l.input_id || Number(l.quantity) <= 0) continue
      const need = Number(l.quantity) * qty * (1 + Number(l.waste_pct) / 100)
      needByInput.set(l.input_id, (needByInput.get(l.input_id) ?? 0) + need)
    }
    type PrevInput = { id: string; name: string; unit: string; quantity: number; reserved_quantity: number; cost_per_unit: number }
    const buildLine = (id: string | null, name: string, unit: string, needed: number, i?: PrevInput) => {
      const available = i ? this.round2(Number(i.quantity) - Number(i.reserved_quantity)) : 0
      const unitCost = i ? Number(i.cost_per_unit) || 0 : 0
      return { input_id: id, name, unit, needed: this.round2(needed), available, sufficient: !!i && available >= needed, unit_cost: unitCost, line_cost: this.round2(needed * unitCost) }
    }

    if (needByInput.size > 0) {
      const ids = [...needByInput.keys()]
      const { data } = await supabaseAdmin.from('production_input').select('id, name, unit, quantity, reserved_quantity, cost_per_unit').in('id', ids)
      const map = new Map((data ?? []).map(r => [(r as PrevInput).id, r as PrevInput]))
      const lines = [...needByInput.entries()].map(([id, need]) => {
        const i = map.get(id)
        return buildLine(id, i?.name ?? '(insumo removido)', i?.unit ?? 'un', need, i)
      })
      return { source: 'bom', quantity: qty, lines, total_cost: this.round2(lines.reduce((s, l) => s + l.line_cost, 0)), all_sufficient: lines.every(l => l.sufficient) }
    }

    // sem BOM → fallback do filamento principal por peso
    const estFilament = metrics.weight_g != null ? this.round2(metrics.weight_g * qty) : 0
    if (estFilament > 0) {
      let q = supabaseAdmin.from('production_input').select('id, name, unit, quantity, reserved_quantity, cost_per_unit')
        .eq('organization_id', orgId).eq('kind', 'filamento').eq('is_active', true).order('quantity', { ascending: false }).limit(1)
      if (metrics.material) q = q.eq('material', metrics.material.toUpperCase())
      const { data } = await q
      const i = (data ?? [])[0] as PrevInput | undefined
      const line = buildLine(i?.id ?? null, i?.name ?? `Filamento ${metrics.material ?? ''}`.trim(), i?.unit ?? 'g', estFilament, i)
      return { source: 'filament', quantity: qty, material: metrics.material, lines: [line], total_cost: line.line_cost, all_sufficient: line.sufficient }
    }
    return { source: 'none', quantity: qty, lines: [], total_cost: 0, all_sufficient: true }
  }

  async createOrder(orgId: string, userId: string | null, body: { product_dev_id: string; version_id?: string; quantity: number; machine?: string; printer_id?: string; is_prototype?: boolean }) {
    const qty = Math.max(1, Math.floor(Number(body.quantity) || 0))
    // protótipo (projeto sem produto cadastrado) consome insumo mas NÃO vira estoque
    // vendável; produção (produto cadastrado) consome insumo + credita products.stock
    const { data: dev } = await supabaseAdmin.from('product_dev').select('product_id').eq('id', body.product_dev_id).eq('organization_id', orgId).maybeSingle()
    const registered = !!(dev as { product_id: string | null } | null)?.product_id
    const isPrototype = body.is_prototype ?? !registered
    // pega métricas da versão (explícita > aprovada > última)
    const metrics = await this.resolveVersionMetrics(orgId, body.product_dev_id, body.version_id)
    const estTime = metrics.print_time_minutes != null ? metrics.print_time_minutes * qty : null
    const estFilament = metrics.weight_g != null ? this.round2(metrics.weight_g * qty) : null

    const { data: seq } = await supabaseAdmin.from('production_order').select('order_number')
      .eq('organization_id', orgId).order('order_number', { ascending: false }).limit(1).maybeSingle()
    const nextNumber = seq ? Number((seq as { order_number: number }).order_number) + 1 : 1

    const { data, error } = await supabaseAdmin.from('production_order').insert({
      organization_id: orgId, product_dev_id: body.product_dev_id, version_id: body.version_id ?? null,
      order_number: nextNumber, quantity: qty, machine: body.machine ?? null, printer_id: body.printer_id ?? null,
      estimated_time_minutes: estTime, estimated_filament_g: estFilament, is_prototype: isPrototype, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar ordem: ${error?.message ?? 'sem dados'}`)
    const order = data as { id: string }

    // reserva de insumos: se há COMPOSIÇÃO (BOM) com insumos vinculados, reserva a
    // composição inteira (qtd_linha × qtd_OP × (1+perda), agregando por insumo);
    // senão, mantém o fallback do filamento principal por peso.
    const bom = await this.getBom(orgId, body.product_dev_id, body.version_id ?? metrics.versionId ?? undefined) as Array<{ input_id: string | null; quantity: number; waste_pct: number }>
    const needByInput = new Map<string, number>()
    for (const l of bom) {
      if (!l.input_id || Number(l.quantity) <= 0) continue
      const need = Number(l.quantity) * qty * (1 + Number(l.waste_pct) / 100)
      needByInput.set(l.input_id, (needByInput.get(l.input_id) ?? 0) + need)
    }
    if (needByInput.size > 0) {
      let firstFilament: string | null = null
      for (const [inputId, need] of needByInput) {
        const ok = await this.inputs.reserveInput(orgId, inputId, this.round2(need), 'production_order', order.id)
        if (ok && !firstFilament) firstFilament = inputId   // p/ referência informativa
      }
      if (firstFilament) await supabaseAdmin.from('production_order').update({ reservation_id: firstFilament }).eq('id', order.id)
    } else if (estFilament && estFilament > 0) {
      const r = await this.inputs.reserveByMaterial(orgId, metrics.material, estFilament, 'production_order', order.id)
      if (r) await supabaseAdmin.from('production_order').update({ reservation_id: r.inputId }).eq('id', order.id)
    }
    await this.emit(orgId, body.product_dev_id, 'production_order_created', { production_order_id: order.id, qty }, userId)
    return this.getOrder(orgId, order.id)
  }

  async transitionOrder(orgId: string, oid: string, to: string, userId: string | null) {
    const order = await this.getOrder(orgId, oid)
    const from = (order as { status: string }).status
    if (from === to) return order
    const allowed = ORDER_TRANSITIONS[from] ?? []
    if (!allowed.includes(to)) throw new BadRequestException(`Transição inválida: '${from}' → '${to}'`)

    const patch: Record<string, unknown> = { status: to }
    if (to === 'imprimindo' && !(order as { started_at: string | null }).started_at) patch.started_at = new Date().toISOString()
    if (to === 'disponivel') patch.completed_at = new Date().toISOString()

    await supabaseAdmin.from('production_order').update(patch).eq('id', oid).eq('organization_id', orgId)

    const devId = (order as { product_dev_id: string }).product_dev_id
    if (to === 'cancelado') {
      await this.inputs.release(orgId, 'production_order', oid)
    }
    if (to === 'disponivel') {
      // baixa insumos + alimenta estoque de produto acabado.
      // Só o peso REAL medido do filamento sobrepõe a reserva; sem medição,
      // consome o reservado (que já inclui a perda do BOM). O estimado NÃO
      // sobrepõe — senão zeraria a perda da composição.
      const actual = (order as { actual_filament_g: number | null }).actual_filament_g ?? undefined
      await this.inputs.consume(orgId, 'production_order', oid, actual ?? undefined)
      await this.snapshotContribution(orgId, devId, oid, Number((order as { quantity: number }).quantity) || 0)
      await this.creditNativeStock(orgId, order as Record<string, unknown>)
      await this.emit(orgId, devId, 'production_completed', { production_order_id: oid }, userId)
    }
    return this.getOrder(orgId, oid)
  }

  /** Credita as unidades produzidas DIRETO em products.stock (NATIVO).
   *  Produto vem do nosso sistema → NÃO usa Icarus (sem ledger/sync de canal).
   *  Idempotente via stock_movement_done. */
  private async creditNativeStock(orgId: string, order: Record<string, unknown>) {
    if (order.stock_movement_done === true) return
    if (order.is_prototype === true) {
      this.logger.log(`[producao] ordem ${(order.id as string).slice(0, 8)} é protótipo — consome insumo, sem estoque vendável`)
      return
    }
    const devId = order.product_dev_id as string
    const { data: dev } = await supabaseAdmin.from('product_dev').select('product_id')
      .eq('id', devId).eq('organization_id', orgId).maybeSingle()
    const productId = (dev as { product_id: string | null } | null)?.product_id
    if (!productId) {
      this.logger.log(`[producao] ordem ${(order.id as string).slice(0, 8)} concluída sem produto cadastrado — sem crédito de estoque`)
      return
    }
    const qty = Number(order.quantity) || 0
    const { data: prod } = await supabaseAdmin.from('products').select('stock').eq('id', productId).maybeSingle()
    const novo = (Number((prod as { stock: number | null } | null)?.stock) || 0) + qty
    await supabaseAdmin.from('products').update({ stock: novo, updated_at: new Date().toISOString() }).eq('id', productId).eq('organization_id', orgId)
    // espelha no registro mestre criado pela plataforma (consistência) — SEM
    // sync de canal/marketplace (não chama recalcAndPropagate = sem Icarus)
    await supabaseAdmin.from('product_stock').update({ quantity: novo, updated_at: new Date().toISOString() }).eq('product_id', productId).is('platform', null)
    await supabaseAdmin.from('production_order').update({ stock_movement_done: true }).eq('id', order.id as string)
    this.logger.log(`[producao] +${qty} un nativas (products.stock=${novo}) p/ ${productId.slice(0, 8)} — sem sync de canal`)
  }

  /** Carimba custo/preço/contribuição na ordem concluída → alimenta o payback
   *  da impressora. Preço = target_price do produto (ou preço do SKU vinculado). */
  private async snapshotContribution(orgId: string, devId: string, oid: string, quantity: number) {
    const { data: dev } = await supabaseAdmin.from('product_dev').select('estimated_cost, target_price, product_id').eq('id', devId).maybeSingle()
    const d = dev as { estimated_cost: number | null; target_price: number | null; product_id: string | null } | null
    let priceUnit = Number(d?.target_price) || 0
    if (!priceUnit && d?.product_id) {
      const { data: prod } = await supabaseAdmin.from('products').select('price').eq('id', d.product_id).maybeSingle()
      priceUnit = Number((prod as { price: number | null } | null)?.price) || 0
    }
    const costUnit = Number(d?.estimated_cost) || 0
    const contribution = this.round2(Math.max(0, priceUnit - costUnit) * quantity)
    await supabaseAdmin.from('production_order').update({
      unit_cost_snapshot: costUnit, unit_price_snapshot: priceUnit, contribution_total: contribution,
    }).eq('id', oid).eq('organization_id', orgId)
  }

  // ── inteligência de rentabilidade (lucro por hora de impressora) ──
  async profitability(orgId: string) {
    const { data: devs } = await supabaseAdmin.from('product_dev')
      .select('id, name, category, estimated_cost, target_price, product_id, production_profile, status')
      .eq('organization_id', orgId).neq('status', 'arquivado')
    const devRows = (devs ?? []) as Array<{ id: string; name: string; category: string | null; estimated_cost: number | null; target_price: number | null; product_id: string | null; production_profile: string; status: string }>
    if (!devRows.length) return []

    const { data: versions } = await supabaseAdmin.from('product_dev_version')
      .select('product_dev_id, version_number, approved, print_time_minutes').eq('organization_id', orgId)
    const { data: orders } = await supabaseAdmin.from('production_order')
      .select('product_dev_id, quantity, status').eq('organization_id', orgId).eq('status', 'disponivel')

    const linkedIds = devRows.map(d => d.product_id).filter(Boolean) as string[]
    const prods = linkedIds.length ? (await supabaseAdmin.from('products').select('id, price').in('id', linkedIds)).data ?? [] : []
    const priceByProduct = new Map(prods.map(p => [(p as { id: string }).id, Number((p as { price: number | null }).price) || 0]))

    const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const sales = linkedIds.length ? (await supabaseAdmin.from('product_sales_snapshots').select('product_id, units_sold, gross_profit, revenue, snapshot_date').eq('organization_id', orgId).gte('snapshot_date', since).in('product_id', linkedIds)).data ?? [] : []
    const salesByProduct = new Map<string, { units: number; profit: number; revenue: number }>()
    for (const s of sales) {
      const row = s as { product_id: string; units_sold: number | null; gross_profit: number | null; revenue: number | null }
      const cur = salesByProduct.get(row.product_id) ?? { units: 0, profit: 0, revenue: 0 }
      cur.units += Number(row.units_sold) || 0; cur.profit += Number(row.gross_profit) || 0; cur.revenue += Number(row.revenue) || 0
      salesByProduct.set(row.product_id, cur)
    }

    const out = devRows.map(d => {
      const vs = (versions ?? []).filter(v => (v as { product_dev_id: string }).product_dev_id === d.id)
        .sort((a, b) => (b as { version_number: number }).version_number - (a as { version_number: number }).version_number)
      const ref = vs.find(v => (v as { approved: boolean }).approved) ?? vs[0]
      const printMin = ref ? Number((ref as { print_time_minutes: number | null }).print_time_minutes) || 0 : 0
      const costUnit = Number(d.estimated_cost) || 0
      const priceUnit = Number(d.target_price) || (d.product_id ? (priceByProduct.get(d.product_id) ?? 0) : 0)
      const contribution = this.round2(priceUnit - costUnit)
      const profitPerHour = printMin > 0 ? this.round2(contribution / (printMin / 60)) : null
      const sale = d.product_id ? salesByProduct.get(d.product_id) : undefined
      const unitsSold30d = sale?.units ?? 0
      const revenue30d = this.round2(sale?.revenue ?? 0)
      const realizedProfit30d = this.round2(sale?.profit ?? 0)
      const unitsProduced = (orders ?? []).filter(o => (o as { product_dev_id: string }).product_dev_id === d.id).reduce((s, o) => s + (Number((o as { quantity: number }).quantity) || 0), 0)

      let recommendation: string
      if (profitPerHour == null) recommendation = 'faltam_dados'
      else if (profitPerHour <= 0) recommendation = 'reavaliar'
      else if (unitsSold30d > 0) recommendation = 'priorizar'
      else recommendation = 'validar_demanda'

      return {
        product_dev_id: d.id, name: d.name, category: d.category,
        print_minutes_unit: printMin, cost_unit: costUnit, price_unit: priceUnit,
        contribution_unit: contribution, profit_per_hour: profitPerHour,
        units_sold_30d: unitsSold30d, units_produced: unitsProduced,
        revenue_30d: revenue30d, realized_profit_30d: realizedProfit30d, recommendation,
      }
    })

    return out.sort((a, b) => (b.profit_per_hour ?? -1) - (a.profit_per_hour ?? -1))
  }

  // ── painel da fábrica (visão executiva consolidada) ───────────────
  async factoryOverview(orgId: string) {
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString()
    const [printersR, ordersR, inputsR, jobsR, prof] = await Promise.all([
      supabaseAdmin.from('production_printer').select('id, name, acquisition_cost, status').eq('organization_id', orgId),
      supabaseAdmin.from('production_order').select('printer_id, status, quantity, contribution_total, completed_at').eq('organization_id', orgId),
      supabaseAdmin.from('production_input').select('id, name, quantity, reserved_quantity, reorder_threshold, unit').eq('organization_id', orgId).eq('is_active', true),
      supabaseAdmin.from('print_job').select('print_time_minutes').eq('organization_id', orgId).eq('status', 'concluido'),
      this.profitability(orgId),
    ])
    const printers = (printersR.data ?? []) as Array<{ id: string; acquisition_cost: number | null; status: string }>
    const orders = (ordersR.data ?? []) as Array<{ printer_id: string | null; status: string; quantity: number; contribution_total: number | null; completed_at: string | null }>
    const inputs = (inputsR.data ?? []) as Array<{ name: string; quantity: number; reserved_quantity: number; reorder_threshold: number; unit: string }>
    const jobs = (jobsR.data ?? []) as Array<{ print_time_minutes: number | null }>

    const done = orders.filter(o => o.status === 'disponivel')
    const totalInvestment = this.round2(printers.reduce((s, p) => s + (Number(p.acquisition_cost) || 0), 0))
    const contribByPrinter = new Map<string, number>()
    let totalContribution = 0
    for (const o of done) {
      const c = Number(o.contribution_total) || 0; totalContribution += c
      if (o.printer_id) contribByPrinter.set(o.printer_id, (contribByPrinter.get(o.printer_id) ?? 0) + c)
    }
    let totalPaidBack = 0, paidOff = 0
    for (const p of printers) {
      const cost = Number(p.acquisition_cost) || 0
      const c = contribByPrinter.get(p.id) ?? 0
      if (cost > 0) { totalPaidBack += Math.min(c, cost); if (c >= cost) paidOff++ }
    }
    totalContribution = this.round2(totalContribution); totalPaidBack = this.round2(totalPaidBack)

    const lowStock = inputs.filter(i => i.reorder_threshold > 0 && (Number(i.quantity) - Number(i.reserved_quantity)) <= i.reorder_threshold)
      .map(i => ({ name: i.name, available: this.round2(Number(i.quantity) - Number(i.reserved_quantity)), unit: i.unit }))

    return {
      printers: {
        count: printers.length,
        active: printers.filter(p => p.status === 'ativa').length,
        total_investment: totalInvestment,
        total_paid_back: totalPaidBack,
        payback_pct: totalInvestment > 0 ? this.round2((totalPaidBack / totalInvestment) * 100) : null,
        paid_off: paidOff,
        total_print_hours: this.round2(jobs.reduce((s, j) => s + (Number(j.print_time_minutes) || 0), 0) / 60),
      },
      production: {
        orders_done: done.length,
        orders_active: orders.filter(o => !['disponivel', 'cancelado'].includes(o.status)).length,
        units_produced: done.reduce((s, o) => s + (Number(o.quantity) || 0), 0),
        units_30d: done.filter(o => o.completed_at && o.completed_at >= since30).reduce((s, o) => s + (Number(o.quantity) || 0), 0),
        total_contribution: totalContribution,
        free_profit: this.round2(Math.max(0, totalContribution - totalPaidBack)),
      },
      sales: {
        revenue_30d: this.round2(prof.reduce((s, p) => s + (Number(p.revenue_30d) || 0), 0)),
        realized_profit_30d: this.round2(prof.reduce((s, p) => s + (Number(p.realized_profit_30d) || 0), 0)),
        units_sold_30d: prof.reduce((s, p) => s + (Number(p.units_sold_30d) || 0), 0),
      },
      inputs: { low_stock: lowStock },
      top_products: prof.slice(0, 5),
    }
  }

  /** Plano de produção: dado o tempo de máquina disponível, sugere o mix que
   *  maximiza o lucro por hora do parque (guloso por R$/hora, limitado pela
   *  demanda real de 30d — não imprime o que não vende). */
  async productionPlan(orgId: string, hoursParam?: number) {
    const prof = await this.profitability(orgId)
    const { data: printers } = await supabaseAdmin.from('production_printer').select('id').eq('organization_id', orgId).eq('status', 'ativa')
    const activeCount = (printers ?? []).length
    // capacidade: parâmetro OU 12h/dia × 7 dias × impressoras ativas
    const capacityHours = Math.max(0, Number(hoursParam) || activeCount * 84)

    const candidates = prof
      .filter(p => p.profit_per_hour != null && p.profit_per_hour > 0 && p.print_minutes_unit > 0 && p.units_sold_30d > 0)
      .sort((a, b) => (b.profit_per_hour ?? 0) - (a.profit_per_hour ?? 0))

    let remaining = capacityHours
    let totalContribution = 0
    const plan: Array<{ product_dev_id: string; name: string; units: number; hours: number; profit_per_hour: number | null; contribution: number }> = []
    for (const c of candidates) {
      if (remaining <= 0) break
      const hoursPerUnit = c.print_minutes_unit / 60
      const units = Math.min(c.units_sold_30d, Math.floor(remaining / hoursPerUnit))
      if (units <= 0) continue
      const hours = this.round2(units * hoursPerUnit)
      const contribution = this.round2(units * c.contribution_unit)
      plan.push({ product_dev_id: c.product_dev_id, name: c.name, units, hours, profit_per_hour: c.profit_per_hour, contribution })
      remaining = this.round2(remaining - hours)
      totalContribution += contribution
    }

    return {
      capacity_hours: this.round2(capacityHours),
      active_printers: activeCount,
      hours_used: this.round2(capacityHours - remaining),
      hours_idle: this.round2(remaining),
      utilization_pct: capacityHours > 0 ? this.round2(((capacityHours - remaining) / capacityHours) * 100) : 0,
      total_contribution: this.round2(totalContribution),
      plan,
    }
  }

  // ── custo real × estimado + consumo de insumo por produto ─────────
  async costReality(orgId: string, devId: string) {
    const { data: devData } = await supabaseAdmin.from('product_dev').select('estimated_cost').eq('id', devId).eq('organization_id', orgId).maybeSingle()
    const estUnit = Number((devData as { estimated_cost: number | null } | null)?.estimated_cost) || 0
    const { data: settings } = await supabaseAdmin.from('production_settings').select('energy_cost_per_hour, labor_cost_per_hour, packaging_cost, default_waste_pct').eq('organization_id', orgId).maybeSingle()
    const s = (settings ?? {}) as { energy_cost_per_hour?: number; labor_cost_per_hour?: number; packaging_cost?: number; default_waste_pct?: number }
    const { data: ordersData } = await supabaseAdmin.from('production_order')
      .select('id, order_number, quantity, actual_time_minutes, estimated_time_minutes, is_prototype')
      .eq('organization_id', orgId).eq('product_dev_id', devId).eq('status', 'disponivel')
    const orders = (ordersData ?? []) as Array<{ id: string; order_number: number; quantity: number; actual_time_minutes: number | null; estimated_time_minutes: number | null; is_prototype: boolean }>
    const orderIds = orders.map(o => o.id)

    let consumes: Array<{ input_id: string; quantity: number; unit_cost: number | null; reference_id: string }> = []
    if (orderIds.length) {
      const { data } = await supabaseAdmin.from('production_input_movement').select('input_id, quantity, unit_cost, reference_id')
        .eq('organization_id', orgId).eq('movement_type', 'consume').eq('reference_type', 'production_order').in('reference_id', orderIds)
      consumes = (data ?? []) as typeof consumes
    }
    const inputIds = [...new Set(consumes.map(c => c.input_id))]
    const inputs = inputIds.length ? ((await supabaseAdmin.from('production_input').select('id, name, unit').in('id', inputIds)).data ?? []) : []
    const inputById = new Map(inputs.map(i => [(i as { id: string }).id, i as { id: string; name: string; unit: string }]))

    const matCostByOrder = new Map<string, number>()
    const consByInput = new Map<string, { qty: number; cost: number }>()
    for (const c of consumes) {
      const cost = (Number(c.quantity) || 0) * (Number(c.unit_cost) || 0)
      matCostByOrder.set(c.reference_id, (matCostByOrder.get(c.reference_id) ?? 0) + cost)
      const cur = consByInput.get(c.input_id) ?? { qty: 0, cost: 0 }; cur.qty += Number(c.quantity) || 0; cur.cost += cost; consByInput.set(c.input_id, cur)
    }

    const energyRate = Number(s.energy_cost_per_hour) || 0, laborRate = Number(s.labor_cost_per_hour) || 0, pkg = Number(s.packaging_cost) || 0, wastePct = Number(s.default_waste_pct) || 0
    let totalUnits = 0, totalReal = 0, totalEst = 0
    const orderRows = orders.map(o => {
      const qty = Number(o.quantity) || 0
      const mins = Number(o.actual_time_minutes ?? o.estimated_time_minutes) || 0
      const material = this.round2(matCostByOrder.get(o.id) ?? 0)
      const sub = material + this.round2(mins / 60 * energyRate) + this.round2(mins / 60 * laborRate) + this.round2(pkg * qty)
      const realTotal = this.round2(sub + this.round2(sub * wastePct / 100))
      const realUnit = qty > 0 ? this.round2(realTotal / qty) : 0
      totalUnits += qty; totalReal += realTotal; totalEst += this.round2(estUnit * qty)
      return { order_number: o.order_number, is_prototype: o.is_prototype, quantity: qty, real_time_min: mins, material_cost: material, real_unit_cost: realUnit, estimated_unit_cost: this.round2(estUnit), real_total: realTotal }
    })
    const realUnitAvg = totalUnits > 0 ? this.round2(totalReal / totalUnits) : 0
    const variancePct = estUnit > 0 ? this.round2(((realUnitAvg - estUnit) / estUnit) * 100) : null
    const consumption = [...consByInput.entries()].map(([id, v]) => ({ name: inputById.get(id)?.name ?? '—', unit: inputById.get(id)?.unit ?? '', qty: this.round2(v.qty), cost: this.round2(v.cost) })).sort((a, b) => b.cost - a.cost)

    return {
      estimated_unit_cost: this.round2(estUnit), real_unit_cost_avg: realUnitAvg, variance_pct: variancePct,
      total_units_produced: totalUnits, total_estimated: this.round2(totalEst), total_real: this.round2(totalReal),
      orders: orderRows.sort((a, b) => b.order_number - a.order_number), consumption,
    }
  }

  // ── fila de impressão (print jobs) ────────────────────────────────
  async listJobs(orgId: string, oid: string) {
    const { data, error } = await supabaseAdmin.from('print_job').select('*')
      .eq('organization_id', orgId).eq('production_order_id', oid).order('job_number', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async createJobs(orgId: string, userId: string | null, oid: string, body: { machine?: string; count?: number }) {
    const order = await this.getOrder(orgId, oid)
    const existing = (order as { jobs: unknown[] }).jobs.length
    const count = Math.min(Math.max(1, Math.floor(Number(body.count) || 1)), 50)
    const rows = Array.from({ length: count }, (_, i) => ({
      organization_id: orgId, production_order_id: oid,
      version_id: (order as { version_id: string | null }).version_id,
      printer_id: (order as { printer_id: string | null }).printer_id,
      job_number: existing + i + 1, machine: body.machine ?? (order as { machine: string | null }).machine, created_by: userId,
    }))
    const { error } = await supabaseAdmin.from('print_job').insert(rows)
    if (error) throw new BadRequestException(`Erro ao criar jobs: ${error.message}`)
    return this.listJobs(orgId, oid)
  }

  async transitionJob(orgId: string, jid: string, body: { status: string; filament_used_g?: number; print_time_minutes?: number; failure_reason?: string }) {
    const { data: job } = await supabaseAdmin.from('print_job').select('*').eq('id', jid).eq('organization_id', orgId).maybeSingle()
    if (!job) throw new NotFoundException('Job não encontrado')
    const patch: Record<string, unknown> = { status: body.status }
    if (body.status === 'imprimindo') patch.started_at = new Date().toISOString()
    if (body.status === 'concluido' || body.status === 'falhou') patch.finished_at = new Date().toISOString()
    if (body.filament_used_g != null) patch.filament_used_g = body.filament_used_g
    if (body.print_time_minutes != null) patch.print_time_minutes = body.print_time_minutes
    if (body.failure_reason != null) patch.failure_reason = body.failure_reason
    await supabaseAdmin.from('print_job').update(patch).eq('id', jid).eq('organization_id', orgId)

    const oid = (job as { production_order_id: string }).production_order_id
    await this.autoAdvanceOrder(orgId, oid, body.status, body.failure_reason)
    return this.getOrder(orgId, oid)
  }

  /** Auto-avança a ordem conforme os jobs: 1º imprimindo→ordem imprimindo;
   *  todos concluídos→acabamento; qualquer falha→falhou. */
  private async autoAdvanceOrder(orgId: string, oid: string, jobStatus: string, failure?: string) {
    const { data: order } = await supabaseAdmin.from('production_order').select('status').eq('id', oid).maybeSingle()
    const cur = (order as { status: string } | null)?.status
    if (!cur || ['disponivel', 'cancelado', 'embalado'].includes(cur)) return

    if (jobStatus === 'imprimindo' && cur === 'fila') {
      await supabaseAdmin.from('production_order').update({ status: 'imprimindo', started_at: new Date().toISOString() }).eq('id', oid)
      return
    }
    if (jobStatus === 'falhou') {
      await supabaseAdmin.from('production_order').update({ status: 'falhou', notes: failure ?? 'Falha em job de impressão' }).eq('id', oid)
      return
    }
    if (jobStatus === 'concluido') {
      const { data: jobs } = await supabaseAdmin.from('print_job').select('status, filament_used_g, print_time_minutes').eq('production_order_id', oid)
      const all = jobs ?? []
      if (all.length && all.every(j => (j as { status: string }).status === 'concluido')) {
        const actualFil = all.reduce((s, j) => s + (Number((j as { filament_used_g: number | null }).filament_used_g) || 0), 0)
        const actualTime = all.reduce((s, j) => s + (Number((j as { print_time_minutes: number | null }).print_time_minutes) || 0), 0)
        await supabaseAdmin.from('production_order').update({
          status: 'acabamento',
          actual_filament_g: actualFil > 0 ? this.round2(actualFil) : null,
          actual_time_minutes: actualTime > 0 ? actualTime : null,
        }).eq('id', oid)
      }
    }
  }

  // ── qualidade ─────────────────────────────────────────────────────
  async getQuality(orgId: string, devId: string, versionId?: string) {
    let q = supabaseAdmin.from('product_dev_quality').select('*')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('created_at', { ascending: false }).limit(1)
    if (versionId) q = q.eq('version_id', versionId)
    const { data } = await q
    return (data ?? [])[0] ?? null
  }

  async upsertQuality(orgId: string, devId: string, userId: string | null, body: {
    version_id?: string; production_order_id?: string; checklist: Array<{ key: string; label: string; ok: boolean }>; approved: boolean; notes?: string
  }) {
    const existing = await this.getQuality(orgId, devId, body.version_id) as { id: string } | null
    const payload = {
      organization_id: orgId, product_dev_id: devId, version_id: body.version_id ?? null,
      production_order_id: body.production_order_id ?? null, checklist: body.checklist ?? [],
      approved: body.approved === true, notes: body.notes ?? null, checked_by: userId,
    }
    if (existing) {
      const { data, error } = await supabaseAdmin.from('product_dev_quality').update(payload).eq('id', existing.id).select('*').maybeSingle()
      if (error) throw new BadRequestException(`Erro: ${error.message}`)
      await this.emit(orgId, devId, 'quality_checked', { approved: payload.approved }, userId)
      return data
    }
    const { data, error } = await supabaseAdmin.from('product_dev_quality').insert(payload).select('*').maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    await this.emit(orgId, devId, 'quality_checked', { approved: payload.approved }, userId)
    return data
  }

  /** Gate de publicação: qualidade aprovada? (bypass p/ perfil genérico sem QC). */
  async isQualityPassed(orgId: string, devId: string, profile: string): Promise<boolean> {
    const q = await this.getQuality(orgId, devId) as { approved: boolean } | null
    if (q) return q.approved === true
    return profile === 'generico'   // genérico/marca própria sem QC não trava
  }

  // ── helpers ───────────────────────────────────────────────────────
  private async resolveVersionMetrics(orgId: string, devId: string, versionId?: string): Promise<VersionMetrics> {
    const { data } = await supabaseAdmin.from('product_dev_version')
      .select('id, weight_g, print_time_minutes, material, approved, version_number')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('version_number', { ascending: false })
    const versions = (data ?? []) as Array<{ id: string; weight_g: number | null; print_time_minutes: number | null; material: string | null; approved: boolean }>
    const ref = versionId ? versions.find(v => v.id === versionId) : (versions.find(v => v.approved) ?? versions[0])
    return { versionId: ref?.id ?? null, weight_g: ref?.weight_g ?? null, print_time_minutes: ref?.print_time_minutes ?? null, material: ref?.material ?? null }
  }
}
