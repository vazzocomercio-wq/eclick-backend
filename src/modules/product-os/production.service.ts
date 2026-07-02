import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { StockService } from '../stock/stock.service'
import { ProductionInputService } from './production-input.service'
import { ProductPartService } from './product-part.service'

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
// OP de PEÇA termina em 'pronta' (vira estoque de peça → montagem/SAC/reposição),
// não passa por Embalado/Disponível (peça não se embala; o PRODUTO é que embala).
const PART_ORDER_TRANSITIONS: Record<string, string[]> = {
  fila:        ['imprimindo', 'cancelado'],
  imprimindo:  ['pausado', 'falhou', 'acabamento', 'cancelado'],
  pausado:     ['imprimindo', 'cancelado'],
  falhou:      ['reimpressao', 'cancelado'],
  reimpressao: ['imprimindo', 'cancelado'],
  acabamento:  ['qualidade', 'cancelado'],
  qualidade:   ['pronta', 'falhou'],
  pronta:      [],
  cancelado:   [],
}

interface Filament { index: number; material: string | null; color: string | null; weight_g: number }
interface VersionMetrics { versionId: string | null; weight_g: number | null; print_time_minutes: number | null; material: string | null; filaments: Filament[] }

@Injectable()
export class ProductionService {
  private readonly logger = new Logger(ProductionService.name)

  constructor(
    private readonly stock: StockService,
    private readonly inputs: ProductionInputService,
    private readonly parts: ProductPartService,
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
    // embute o preview extraído do .3mf (imagem do card) + nome/código da peça
    let q = supabaseAdmin.from('production_order').select('*, version:product_dev_version(thumbnail_url), part:product_dev_part(name, code)')
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
  async previewOrderConsumption(orgId: string, body: { product_dev_id: string; version_id?: string; quantity: number; part_id?: string | null }) {
    const qty = Math.max(1, Math.floor(Number(body.quantity) || 0))
    const partId = body.part_id ?? null
    const metrics = await this.resolveVersionMetrics(orgId, body.product_dev_id, body.version_id, partId)
    // OP de peça reserva só filamento (sem BOM de produto montado)
    const bom = partId ? [] : await this.getBom(orgId, body.product_dev_id, body.version_id ?? metrics.versionId ?? undefined) as Array<{ input_id: string | null; quantity: number; waste_pct: number }>
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

  async createOrder(orgId: string, userId: string | null, body: { product_dev_id: string; version_id?: string; quantity: number; machine?: string; printer_id?: string; is_prototype?: boolean; part_id?: string | null; loaded_input_id?: string | null; filament_map?: Array<{ index: number; input_id: string }> | null; sku_variant_id?: string | null }) {
    const qty = Math.max(1, Math.floor(Number(body.quantity) || 0))
    const partId = body.part_id ?? null
    // protótipo (projeto sem produto cadastrado) consome insumo mas NÃO vira estoque
    // vendável; produção (produto cadastrado) consome insumo + credita products.stock.
    // OP de PEÇA nunca é protótipo: ela alimenta o estoque de peças prontas.
    const { data: dev } = await supabaseAdmin.from('product_dev').select('product_id').eq('id', body.product_dev_id).eq('organization_id', orgId).maybeSingle()
    const registered = !!(dev as { product_id: string | null } | null)?.product_id
    const isPrototype = partId ? false : (body.is_prototype ?? !registered)
    // pega métricas da versão — da PEÇA se for OP de peça, senão do produto inteiro
    const metrics = await this.resolveVersionMetrics(orgId, body.product_dev_id, body.version_id, partId)
    const estTime = metrics.print_time_minutes != null ? metrics.print_time_minutes * qty : null
    const estFilament = metrics.weight_g != null ? this.round2(metrics.weight_g * qty) : null

    const { data: seq } = await supabaseAdmin.from('production_order').select('order_number')
      .eq('organization_id', orgId).order('order_number', { ascending: false }).limit(1).maybeSingle()
    const nextNumber = seq ? Number((seq as { order_number: number }).order_number) + 1 : 1

    // ── PLANO de reserva (ANTES de criar a ordem): resolve de onde sai cada
    // insumo e valida o saldo disponível. Sem saldo → erro claro e nada é criado
    // (antes, a OP nascia mesmo sem insumo e a reserva estourava o estoque).
    //  - OP de PEÇA → só filamento pelo material/peso da peça (BOM é do produto montado, não da peça)
    //  - OP do produto inteiro → COMPOSIÇÃO (BOM) com insumos vinculados, se houver; senão filamento por peso
    const bom = partId ? [] : await this.getBom(orgId, body.product_dev_id, body.version_id ?? metrics.versionId ?? undefined) as Array<{ input_id: string | null; quantity: number; waste_pct: number }>
    const needByInput = new Map<string, number>()
    for (const l of bom) {
      if (!l.input_id || Number(l.quantity) <= 0) continue
      const need = Number(l.quantity) * qty * (1 + Number(l.waste_pct) / 100)
      needByInput.set(l.input_id, (needByInput.get(l.input_id) ?? 0) + need)
    }
    const plan = new Map<string, number>()               // input_id → qtd a reservar
    let planFilamentMap: Array<{ index: number; input_id: string; weight_g: number }> | null = null
    if (needByInput.size > 0) {
      for (const [inputId, need] of needByInput) plan.set(inputId, this.round2(need))
    } else if (metrics.filaments.length > 1) {
      // MULTICOR: cada cor do .3mf reserva do rolo escolhido (filament_map index→rolo);
      // sem escolha, cai no rolo montado que casa o material. Agrega por insumo (mesma cor 2×).
      const chosen = new Map((body.filament_map ?? []).map(m => [Number(m.index), m.input_id]))
      const stored: Array<{ index: number; input_id: string; weight_g: number }> = []
      for (const fil of metrics.filaments) {
        const g = this.round2(Number(fil.weight_g) * qty)
        if (g <= 0) continue
        let inputId = chosen.get(fil.index) ?? null
        if (inputId && body.printer_id && !(await this.inputs.isLoadedOnPrinter(orgId, body.printer_id, inputId))) inputId = null
        if (!inputId && body.printer_id) inputId = await this.inputs.loadedInputId(orgId, body.printer_id, fil.material)
        if (!inputId) continue
        plan.set(inputId, this.round2((plan.get(inputId) ?? 0) + g))
        stored.push({ index: fil.index, input_id: inputId, weight_g: g })
      }
      planFilamentMap = stored
    } else if (estFilament && estFilament > 0) {
      // 1) rolo ESCOLHIDO pelo usuário (cor/slot exato) — só se estiver montado na impressora;
      // 2) senão, rolo MONTADO que casa o material; 3) senão, fallback por material/peso.
      let candidate: string | null = null
      if (body.loaded_input_id && body.printer_id && await this.inputs.isLoadedOnPrinter(orgId, body.printer_id, body.loaded_input_id)) candidate = body.loaded_input_id
      if (!candidate && body.printer_id) candidate = await this.inputs.loadedInputId(orgId, body.printer_id, metrics.material)
      if (!candidate) candidate = await this.inputs.pickByMaterial(orgId, metrics.material)
      if (candidate) plan.set(candidate, estFilament)
    }

    // valida disponibilidade (quantidade − já reservado) de cada insumo do plano
    if (plan.size > 0) {
      const { data: rows } = await supabaseAdmin.from('production_input')
        .select('id, name, unit, quantity, reserved_quantity').eq('organization_id', orgId).in('id', [...plan.keys()])
      const byId = new Map((rows ?? []).map(r => [(r as { id: string }).id, r as { id: string; name: string; unit: string; quantity: number; reserved_quantity: number }]))
      const faltas: string[] = []
      for (const [inputId, need] of plan) {
        const i = byId.get(inputId)
        const available = i ? this.round2(Number(i.quantity) - Number(i.reserved_quantity)) : 0
        if (!i || available < need) faltas.push(`${i?.name ?? 'insumo removido'} (precisa ${need}${i?.unit ?? ''}, tem ${available}${i?.unit ?? ''})`)
      }
      if (faltas.length) throw new BadRequestException(`Estoque de insumo insuficiente para essa ordem: ${faltas.join(', ')}. Reponha o insumo ou reduza a quantidade.`)
    }

    const { data, error } = await supabaseAdmin.from('production_order').insert({
      organization_id: orgId, product_dev_id: body.product_dev_id, version_id: body.version_id ?? metrics.versionId ?? null, part_id: partId,
      order_number: nextNumber, quantity: qty, machine: body.machine ?? null, printer_id: body.printer_id ?? null, sku_variant_id: body.sku_variant_id ?? null,
      estimated_time_minutes: estTime, estimated_filament_g: estFilament, is_prototype: isPrototype, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar ordem: ${error?.message ?? 'sem dados'}`)
    const order = data as { id: string }

    // aplica as reservas do plano (idempotente por insumo+ordem)
    if (plan.size > 0) {
      for (const [inputId, need] of plan) await this.inputs.reserveInput(orgId, inputId, need, 'production_order', order.id)
      const patch: Record<string, unknown> = { reservation_id: [...plan.keys()][0] }
      if (planFilamentMap) patch.filament_map = planFilamentMap
      await supabaseAdmin.from('production_order').update(patch).eq('id', order.id)
    }
    // gera as unidades físicas (serial único por unidade; lote = esta OP).
    // Prato com composição: seriais = unidades da PRÓPRIA peça por prato × pratos.
    let serialQty = qty
    if (partId) {
      const comp = await this.plateComposition(orgId, body.version_id ?? metrics.versionId ?? null).catch(() => [])
      const own = comp.find(c => c.part_id === partId)
      if (own) serialQty = own.units * qty
    }
    await this.generateUnits(orgId, order.id, nextNumber, serialQty, body.product_dev_id, partId).catch(() => {})
    await this.emit(orgId, body.product_dev_id, 'production_order_created', { production_order_id: order.id, qty }, userId)
    return this.getOrder(orgId, order.id)
  }

  /** Código de exibição da OP a partir do número sequencial. */
  private opCode(orderNumber: number): string { return `OP${String(orderNumber).padStart(4, '0')}` }

  /** Cria 1 linha por unidade da OP: serial = OP0005-{cod}-001. lote=OP, identidade=serial. */
  private async generateUnits(orgId: string, orderId: string, orderNumber: number, qty: number, devId: string, partId: string | null) {
    const op = this.opCode(orderNumber)
    const base = partId ? await this.parts.ensurePartCode(orgId, partId) : await this.parts.ensureDevCode(orgId, devId)
    const rows = Array.from({ length: qty }, (_, i) => ({
      organization_id: orgId, production_order_id: orderId, product_dev_id: devId, part_id: partId,
      serial: `${op}-${base}-${String(i + 1).padStart(3, '0')}`, seq: i + 1, status: 'planejada',
    }))
    if (rows.length) await supabaseAdmin.from('production_unit').insert(rows)
  }

  /** Marca as unidades planejadas da OP como produzidas (peças físicas existem). */
  private async markUnitsProduced(orgId: string, orderId: string) {
    await supabaseAdmin.from('production_unit').update({ status: 'produzida' })
      .eq('organization_id', orgId).eq('production_order_id', orderId).eq('status', 'planejada').then(() => {}, () => {})
  }

  /** Lista as unidades (seriais) de uma OP. */
  async listUnits(orgId: string, oid: string) {
    const { data, error } = await supabaseAdmin.from('production_unit').select('*')
      .eq('organization_id', orgId).eq('production_order_id', oid).order('seq', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  /** Atualiza campos editáveis da ordem (ex: peso REAL pesado na balança).
   *  O peso real sobrepõe o estimado no custo quando a OP chega em 'disponível'. */
  async updateOrder(orgId: string, oid: string, patch: { actual_filament_g?: number | null; actual_time_minutes?: number | null; notes?: string | null; due_at?: string | null }) {
    const safe: Record<string, unknown> = {}
    if ('actual_filament_g' in patch) safe.actual_filament_g = patch.actual_filament_g != null && Number(patch.actual_filament_g) > 0 ? this.round2(Number(patch.actual_filament_g)) : null
    if ('actual_time_minutes' in patch) safe.actual_time_minutes = patch.actual_time_minutes != null && Number(patch.actual_time_minutes) > 0 ? Math.round(Number(patch.actual_time_minutes)) : null
    if ('notes' in patch) safe.notes = patch.notes ?? null
    if ('due_at' in patch) safe.due_at = patch.due_at ? new Date(patch.due_at).toISOString() : null
    if (!Object.keys(safe).length) return this.getOrder(orgId, oid)
    const { error } = await supabaseAdmin.from('production_order').update(safe).eq('id', oid).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao atualizar ordem: ${error.message}`)
    return this.getOrder(orgId, oid)
  }

  async transitionOrder(orgId: string, oid: string, to: string, userId: string | null) {
    const order = await this.getOrder(orgId, oid)
    const from = (order as { status: string }).status
    if (from === to) return order
    const partId = (order as { part_id: string | null }).part_id ?? null
    const transitions = partId ? PART_ORDER_TRANSITIONS : ORDER_TRANSITIONS
    const allowed = transitions[from] ?? []
    if (!allowed.includes(to)) throw new BadRequestException(`Transição inválida: '${from}' → '${to}'`)

    // OP de peça conclui em 'pronta' (vira estoque de peça); produto inteiro em 'disponivel'.
    const completionState = partId ? 'pronta' : 'disponivel'
    const patch: Record<string, unknown> = { status: to, last_transition_source: 'manual', status_changed_at: new Date().toISOString() }
    if (to === 'imprimindo' && !(order as { started_at: string | null }).started_at) patch.started_at = new Date().toISOString()
    if (to === completionState) patch.completed_at = new Date().toISOString()

    // compare-and-swap: só atualiza se o status AINDA é o lido — dois cliques
    // simultâneos não concluem 2× (consumo/crédito de estoque duplicado)
    const { data: updated, error: upErr } = await supabaseAdmin.from('production_order').update(patch)
      .eq('id', oid).eq('organization_id', orgId).eq('status', from).select('id')
    if (upErr) throw new BadRequestException(`Erro ao mudar status para '${to}': ${upErr.message}`)   // não segue p/ baixar estoque se o status não mudou
    if (!updated?.length) throw new BadRequestException('A ordem mudou de status em outra aba/clique — recarregue o quadro e tente de novo.')

    const devId = (order as { product_dev_id: string }).product_dev_id
    if (to === 'acabamento') await this.markUnitsProduced(orgId, oid)   // peças físicas existem
    if (to === 'cancelado') {
      await this.inputs.release(orgId, 'production_order', oid)
    }
    if (to === completionState) {
      // baixa insumos + alimenta estoque (de peça OU de produto acabado).
      // Só o peso REAL medido do filamento sobrepõe a reserva; sem medição,
      // consome o reservado (que já inclui a perda do BOM). O estimado NÃO
      // sobrepõe — senão zeraria a perda da composição.
      const actual = (order as { actual_filament_g: number | null }).actual_filament_g ?? undefined
      await this.inputs.consume(orgId, 'production_order', oid, actual ?? undefined)
      // soma o filamento usado na conta do rolo montado na impressora (relatório por rolo)
      const printerId = (order as { printer_id: string | null }).printer_id
      const gUsed = (order as { actual_filament_g: number | null }).actual_filament_g ?? (order as { estimated_filament_g: number | null }).estimated_filament_g
      if (printerId && gUsed) await this.inputs.bumpLoadedSession(orgId, printerId, Number(gUsed))
      if (partId) {
        // OP de PEÇA → credita o estoque de peças prontas (não o produto acabado).
        // Prato com COMPOSIÇÃO (várias cópias e/ou peças diferentes juntas):
        // quantity = PRATOS e cada peça listada recebe units × pratos.
        const qtyOrd = Number((order as { quantity: number }).quantity) || 0
        const comp = await this.plateComposition(orgId, (order as { version_id: string | null }).version_id)
        if (comp.length) {
          for (const c of comp) await this.parts.creditFromOrder(orgId, c.part_id, c.units * qtyOrd, oid, userId)
        } else {
          await this.parts.creditFromOrder(orgId, partId, qtyOrd, oid, userId)
        }
      } else {
        await this.snapshotContribution(orgId, devId, oid, Number((order as { quantity: number }).quantity) || 0)
        await this.creditNativeStock(orgId, order as Record<string, unknown>)
      }
      await this.emit(orgId, devId, 'production_completed', { production_order_id: oid, part_id: partId }, userId)
    }
    return this.getOrder(orgId, oid)
  }

  /** Composição do prato da versão: [{ part_id, units }] normalizado (units
   *  int ≥1). Vazio = versão comum (1 arquivo = quantity unidades da peça). */
  private async plateComposition(orgId: string, versionId: string | null): Promise<Array<{ part_id: string; units: number }>> {
    if (!versionId) return []
    const { data } = await supabaseAdmin.from('product_dev_version')
      .select('plate_composition').eq('id', versionId).eq('organization_id', orgId).maybeSingle()
    const raw = (data as { plate_composition: Array<{ part_id?: string; units?: number }> | null } | null)?.plate_composition
    if (!Array.isArray(raw)) return []
    return raw
      .filter(c => c && typeof c.part_id === 'string' && Number(c.units) > 0)
      .map(c => ({ part_id: c.part_id as string, units: Math.max(1, Math.round(Number(c.units))) }))
  }

  /** Desfaz o último movimento do quadro (toast "Desfazer"). Só entre etapas
   *  SEM efeito colateral de estoque — conclusão (pronta/disponivel) e
   *  cancelamento (libera reserva) NÃO têm undo. Volta direto pro status
   *  anterior sem passar pela máquina de estados (é um desfazer, não avanço). */
  async undoTransition(orgId: string, oid: string, to: string, userId: string | null) {
    const SAFE = ['fila', 'imprimindo', 'pausado', 'acabamento', 'qualidade', 'embalado', 'reimpressao', 'falhou']
    const order = await this.getOrder(orgId, oid)
    const from = (order as { status: string }).status
    if (from === to) return order
    if (!SAFE.includes(from) || !SAFE.includes(to)) throw new BadRequestException('Esse movimento não pode ser desfeito (a etapa mexe em estoque/reserva).')
    // desfazer = SÓ o inverso de um avanço válido (to → from existe na máquina de
    // estados). Sem isso, "desfazer" viraria atalho pra PULAR etapas pra frente.
    const partUndo = (order as { part_id: string | null }).part_id ? PART_ORDER_TRANSITIONS : ORDER_TRANSITIONS
    if (!(partUndo[to] ?? []).includes(from)) throw new BadRequestException(`Desfazer de '${from}' para '${to}' não é um retorno válido — use o avanço normal do quadro.`)
    const { error } = await supabaseAdmin.from('production_order')
      .update({ status: to, last_transition_source: 'manual', status_changed_at: new Date().toISOString() })
      .eq('id', oid).eq('organization_id', orgId).eq('status', from)
    if (error) throw new BadRequestException(`Erro ao desfazer: ${error.message}`)
    await this.emit(orgId, (order as { product_dev_id: string }).product_dev_id, 'status_changed', { production_order_id: oid, to, undo: true }, userId)
    return this.getOrder(orgId, oid)
  }

  /** Credita as unidades produzidas no ESTOQUE UNIFICADO via StockService
   *  (applyProductionRestock): cria a linha mestre do ledger se faltar, grava
   *  stock_movements (idempotente por OP) e propaga products.stock/canais.
   *  Antes era um UPDATE direto que virava no-op silencioso sem a linha mestre
   *  — o que quebrava o Make-to-Order em loop de sugestão infinita. */
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

    // PRODUTO VARIÁVEL + OP com cor definida → soma na variação certa (match por
    // sku=base-cor) no jsonb; o total/mestre é responsabilidade do ledger abaixo.
    const variantId = (order.sku_variant_id as string | null) ?? null
    if (variantId) {
      const { data: prod } = await supabaseAdmin.from('products').select('has_variations, variations').eq('id', productId).eq('organization_id', orgId).maybeSingle()
      const p = prod as { has_variations: boolean | null; variations: Array<Record<string, unknown>> | null } | null
      if (p?.has_variations) {
        const { data: variant } = await supabaseAdmin.from('product_dev_sku_variant').select('sku').eq('id', variantId).eq('organization_id', orgId).maybeSingle()
        const vsku = (variant as { sku: string } | null)?.sku
        const variations = (p.variations ?? []) as Array<{ sku?: string; stock?: number } & Record<string, unknown>>
        let matched = false
        const updated = variations.map(v => (vsku && v.sku === vsku) ? (matched = true, { ...v, stock: (Number(v.stock) || 0) + qty }) : v)
        if (matched) {
          await supabaseAdmin.from('products').update({ variations: updated, updated_at: new Date().toISOString() }).eq('id', productId).eq('organization_id', orgId)
          this.logger.log(`[producao] +${qty} un na cor ${vsku} p/ ${productId.slice(0, 8)}`)
        } else {
          this.logger.warn(`[producao] variante ${variantId.slice(0, 8)} não casa nenhuma variação do produto ${productId.slice(0, 8)} — crédito cai no total`)
        }
      }
    }

    const res = await this.stock.applyProductionRestock({
      productId, quantity: qty, refId: order.id as string,
      note: `Produção concluída — ${this.opCode(Number(order.order_number) || 0)} (Product OS)`,
    })
    await supabaseAdmin.from('production_order').update({ stock_movement_done: true }).eq('id', order.id as string)
    this.logger.log(`[producao] +${qty} un no ledger (${res}) p/ ${productId.slice(0, 8)}`)
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
      .select('product_dev_id, version_number, approved, print_time_minutes').eq('organization_id', orgId).is('part_id', null)
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
    const [printersR, ordersR, inputsR, consumesR, prof] = await Promise.all([
      supabaseAdmin.from('production_printer').select('id, name, acquisition_cost, status').eq('organization_id', orgId),
      supabaseAdmin.from('production_order').select('printer_id, status, quantity, contribution_total, completed_at, actual_time_minutes').eq('organization_id', orgId),
      supabaseAdmin.from('production_input').select('id, name, kind, quantity, reserved_quantity, reorder_threshold, unit').eq('organization_id', orgId).eq('is_active', true),
      supabaseAdmin.from('production_input_movement').select('input_id, quantity, unit_cost, created_at').eq('organization_id', orgId).eq('movement_type', 'consume'),
      this.profitability(orgId),
    ])
    const printers = (printersR.data ?? []) as Array<{ id: string; acquisition_cost: number | null; status: string }>
    const orders = (ordersR.data ?? []) as Array<{ printer_id: string | null; status: string; quantity: number; contribution_total: number | null; completed_at: string | null; actual_time_minutes: number | null }>
    const inputs = (inputsR.data ?? []) as Array<{ id: string; name: string; kind: string | null; quantity: number; reserved_quantity: number; reorder_threshold: number; unit: string }>
    const consumes = (consumesR.data ?? []) as Array<{ input_id: string; quantity: number | null; unit_cost: number | null; created_at: string }>

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

    // material consumido (real, independe de preço de venda): custo (todos os insumos) + gramas (só filamento)
    const filamentIds = new Set(inputs.filter(i => i.kind === 'filamento').map(i => i.id))
    let materialCostTotal = 0, materialCost30d = 0, filamentGTotal = 0, filamentG30d = 0
    for (const m of consumes) {
      const qty = Number(m.quantity) || 0
      const cost = qty * (Number(m.unit_cost) || 0)
      materialCostTotal += cost
      if (m.created_at >= since30) materialCost30d += cost
      if (filamentIds.has(m.input_id)) { filamentGTotal += qty; if (m.created_at >= since30) filamentG30d += qty }
    }

    // horas impressas: tempo REAL da própria ordem (actual_time_minutes) — o print_job é
    // fila opcional e fica vazio no fluxo "manda .3mf direto"; o tempo real mora na OP.
    const totalPrintHours = this.round2(orders.reduce((s, o) => s + (Number(o.actual_time_minutes) || 0), 0) / 60)

    return {
      printers: {
        count: printers.length,
        active: printers.filter(p => p.status === 'ativa').length,
        total_investment: totalInvestment,
        total_paid_back: totalPaidBack,
        payback_pct: totalInvestment > 0 ? this.round2((totalPaidBack / totalInvestment) * 100) : null,
        paid_off: paidOff,
        total_print_hours: totalPrintHours,
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
      material: {
        filament_g_total: this.round2(filamentGTotal),
        filament_g_30d: this.round2(filamentG30d),
        cost_total: this.round2(materialCostTotal),
        cost_30d: this.round2(materialCost30d),
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
    const JOB_STATUSES = ['fila', 'imprimindo', 'concluido', 'falhou', 'cancelado']
    if (!JOB_STATUSES.includes(body.status)) throw new BadRequestException(`Status de job inválido: '${body.status}'`)
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
      // só avança pra acabamento se a OP ainda está na fase de impressão —
      // um job atrasado não pode REGREDIR uma OP que já foi pra qualidade/embalado
      if (!['fila', 'imprimindo', 'pausado', 'reimpressao'].includes(cur)) return
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

  /** Gate de publicação: qualidade aprovada? Sem registro de QC, genérico e
   *  marca própria não travam (o checklist é recomendado, não obrigatório);
   *  se EXISTE registro, ele precisa estar aprovado. */
  async isQualityPassed(orgId: string, devId: string, profile: string): Promise<boolean> {
    const q = await this.getQuality(orgId, devId) as { approved: boolean } | null
    if (q) return q.approved === true
    return ['generico', 'marca_propria'].includes(profile)
  }

  // ── helpers ───────────────────────────────────────────────────────
  private async resolveVersionMetrics(orgId: string, devId: string, versionId?: string, partId?: string | null): Promise<VersionMetrics> {
    let q = supabaseAdmin.from('product_dev_version')
      .select('id, weight_g, print_time_minutes, material, approved, version_number, filaments')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('version_number', { ascending: false })
    // OP de peça → versões da peça; OP de produto inteiro → versões sem peça
    q = partId ? q.eq('part_id', partId) : q.is('part_id', null)
    const { data } = await q
    const versions = (data ?? []) as Array<{ id: string; weight_g: number | null; print_time_minutes: number | null; material: string | null; approved: boolean; filaments: Filament[] | null }>
    const ref = versionId ? versions.find(v => v.id === versionId) : (versions.find(v => v.approved) ?? versions[0])
    return { versionId: ref?.id ?? null, weight_g: ref?.weight_g ?? null, print_time_minutes: ref?.print_time_minutes ?? null, material: ref?.material ?? null, filaments: (ref?.filaments ?? []) as Filament[] }
  }
}
