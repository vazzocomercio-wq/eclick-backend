import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { ProductionInputService } from './production-input.service'
import { StockService } from '../stock/stock.service'
import { LlmService } from '../ai/llm.service'

/**
 * Product OS — PEÇAS & MONTAGEM.
 *
 * Um produto pode ser composto por várias PEÇAS imprimíveis (base, cúpula,
 * conector…). Cada peça tem versões/arquivos próprios, pode ser produzida
 * sozinha (OP de peça → credita o estoque de peças prontas) e a MONTAGEM
 * consome peças prontas + insumos de montagem → vira produto acabado.
 *
 * Espelha o ledger de insumos (master + movimentos, reserva/consumo idempotente).
 */

const CHANNEL_ALLIN_FEE_PCT: Record<string, number> = {
  mercado_livre: 24.5, shopee: 31.6, tiktok: 8, loja: 0,
}

const ASSEMBLY_TRANSITIONS: Record<string, string[]> = {
  fila:       ['montando', 'cancelado'],
  montando:   ['embalado', 'cancelado'],   // montou → embala
  embalado:   ['disponivel'],               // embalado → disponível p/ venda
  disponivel: [],
  concluido:  [],                           // legado (montagens antigas)
  cancelado:  [],
}

interface PartRef { id: string; name: string; qty_per_product: number; stock_qty: number; reserved_qty: number }
interface PartVersionMetrics { weight_g: number | null; print_time_minutes: number | null; material: string | null }

@Injectable()
export class ProductPartService {
  private readonly logger = new Logger(ProductPartService.name)

  constructor(
    private readonly inputs: ProductionInputService,
    private readonly stock: StockService,
    private readonly llm: LlmService,
  ) {}

  private round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }

  private async emit(orgId: string, devId: string, type: string, payload: Record<string, unknown>, userId?: string | null) {
    await supabaseAdmin.from('product_dev_event').insert({
      organization_id: orgId, product_dev_id: devId, event_type: type, payload, actor_id: userId ?? null,
    }).then(() => {}, () => {})
  }

  // ══ Códigos / sub-SKUs (rastreio) ══════════════════════════════════
  /** Normaliza um texto em código: MAIÚSCULAS, sem acento, só A-Z0-9 e hífen. */
  private toCode(s: string): string {
    return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'PROD'
  }

  /** Garante o código interno do produto (base dos sub-SKUs). Prefere o SKU de
   *  venda se já publicado; senão deriva do nome. Estável depois de gerado. */
  async ensureDevCode(orgId: string, devId: string): Promise<string> {
    const { data } = await supabaseAdmin.from('product_dev').select('code, name, product_id').eq('id', devId).eq('organization_id', orgId).maybeSingle()
    const d = data as { code: string | null; name: string; product_id: string | null } | null
    if (!d) throw new NotFoundException('Produto não encontrado')
    if (d.code) return d.code
    let base = ''
    if (d.product_id) {
      const { data: prod } = await supabaseAdmin.from('products').select('sku').eq('id', d.product_id).maybeSingle()
      const sku = ((prod as { sku: string | null } | null)?.sku || '').trim()
      if (sku) base = this.toCode(sku)   // só usa o SKU se existir (toCode('') vira 'PROD')
    }
    if (!base) base = this.toCode(d.name)
    let code = base, n = 1
    for (;;) {
      const { data: clash } = await supabaseAdmin.from('product_dev').select('id').eq('organization_id', orgId).eq('code', code).neq('id', devId).maybeSingle()
      if (!clash) break
      n++; code = `${base}-${n}`
    }
    await supabaseAdmin.from('product_dev').update({ code }).eq('id', devId).eq('organization_id', orgId)
    return code
  }

  /** Próximo sub-SKU sequencial (-P01, -P02…) pro produto. O "P" separa o
   *  namespace de PEÇA do de variante de COR (VZ-xxxx-01 podia ser tanto a
   *  peça 1 quanto a cor 01 PRETO — colisão real). Aceita códigos legados
   *  sem o P na hora de achar o próximo número. */
  private async nextPartCode(orgId: string, devId: string): Promise<string> {
    const base = await this.ensureDevCode(orgId, devId)
    const { data } = await supabaseAdmin.from('product_dev_part').select('code').eq('organization_id', orgId).eq('product_dev_id', devId)
    let max = 0
    for (const r of (data ?? [])) {
      const m = (r as { code: string | null }).code?.match(/-P?(\d+)$/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    return `${base}-P${String(max + 1).padStart(2, '0')}`
  }

  /** Garante o sub-SKU da peça (gera se faltar). Usado por OPs antigas/backfill. */
  async ensurePartCode(orgId: string, partId: string): Promise<string> {
    const { data } = await supabaseAdmin.from('product_dev_part').select('code, product_dev_id').eq('id', partId).eq('organization_id', orgId).maybeSingle()
    const p = data as { code: string | null; product_dev_id: string } | null
    if (!p) throw new NotFoundException('Peça não encontrada')
    if (p.code) return p.code
    const code = await this.nextPartCode(orgId, p.product_dev_id)
    await supabaseAdmin.from('product_dev_part').update({ code }).eq('id', partId).eq('organization_id', orgId)
    return code
  }

  // ══ Peças (CRUD) ═══════════════════════════════════════════════════
  async listParts(orgId: string, devId: string) {
    const { data, error } = await supabaseAdmin.from('product_dev_part').select('*')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('sort_order', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []).map(p => {
      const r = p as PartRef & { is_optional: boolean; width_mm: number | null; depth_mm: number | null; height_mm: number | null }
      return { ...r, available: this.round2(Number(r.stock_qty) - Number(r.reserved_qty)) }
    })
  }

  async createPart(orgId: string, devId: string, userId: string | null, dto: { name: string; qty_per_product?: number; is_optional?: boolean; sort_order?: number; notes?: string; width_mm?: number | null; depth_mm?: number | null; height_mm?: number | null }) {
    if (!dto.name?.trim()) throw new BadRequestException('Nome da peça é obrigatório')
    const { data: dev } = await supabaseAdmin.from('product_dev').select('id').eq('id', devId).eq('organization_id', orgId).maybeSingle()
    if (!dev) throw new NotFoundException('Produto não encontrado')
    const { data: seq } = await supabaseAdmin.from('product_dev_part').select('sort_order')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('sort_order', { ascending: false }).limit(1).maybeSingle()
    const nextSort = dto.sort_order ?? (seq ? Number((seq as { sort_order: number }).sort_order) + 1 : 0)
    const code = await this.nextPartCode(orgId, devId)   // sub-SKU sequencial {produto}-NN
    const { data, error } = await supabaseAdmin.from('product_dev_part').insert({
      organization_id: orgId, product_dev_id: devId, name: dto.name.trim(), code,
      qty_per_product: Math.max(1, Number(dto.qty_per_product) || 1), is_optional: dto.is_optional === true,
      width_mm: dto.width_mm ?? null, depth_mm: dto.depth_mm ?? null, height_mm: dto.height_mm ?? null,
      sort_order: nextSort, notes: dto.notes ?? null, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar peça: ${error?.message ?? 'sem dados'}`)
    await this.emit(orgId, devId, 'part_added' as string, { part_id: (data as { id: string }).id, name: dto.name }, userId)
    return data
  }

  /** Cria várias peças de uma vez (usado pela sugestão de IA). */
  async createPartsBulk(orgId: string, devId: string, userId: string | null, parts: Array<{ name: string; qty_per_product?: number; is_optional?: boolean; notes?: string; width_mm?: number | null; depth_mm?: number | null; height_mm?: number | null }>) {
    const created = []
    for (const p of parts) { if (p?.name?.trim()) created.push(await this.createPart(orgId, devId, userId, p)) }
    return created
  }

  async updatePart(orgId: string, partId: string, patch: { name?: string; qty_per_product?: number; is_optional?: boolean; sort_order?: number; notes?: string; width_mm?: number | null; depth_mm?: number | null; height_mm?: number | null; code?: string | null }) {
    const safe: Record<string, unknown> = {}
    if (patch.name != null) safe.name = String(patch.name).trim()
    if (patch.qty_per_product != null) safe.qty_per_product = Math.max(1, Number(patch.qty_per_product) || 1)
    if (patch.is_optional != null) safe.is_optional = patch.is_optional === true
    if (patch.sort_order != null) safe.sort_order = Number(patch.sort_order) || 0
    if (patch.notes != null) safe.notes = patch.notes
    if ('code' in patch) safe.code = patch.code ? this.toCode(String(patch.code)) : null
    if ('width_mm' in patch) safe.width_mm = patch.width_mm ?? null
    if ('depth_mm' in patch) safe.depth_mm = patch.depth_mm ?? null
    if ('height_mm' in patch) safe.height_mm = patch.height_mm ?? null
    if (!Object.keys(safe).length) throw new BadRequestException('Nada para atualizar')
    const { data, error } = await supabaseAdmin.from('product_dev_part').update(safe)
      .eq('id', partId).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrada'}`)
    return data
  }

  /** Exclui a peça (+ versões + movimentos, via cascade do banco). Bloqueia se
   *  houver reserva ativa (montagem/OP em andamento) — nesse caso conclua/cancele antes. */
  async deletePart(orgId: string, partId: string): Promise<{ deleted: boolean }> {
    const part = await this.getPart(orgId, partId)
    if (Number(part.reserved_qty) > 0) throw new BadRequestException('Peça reservada por uma montagem/ordem em andamento — conclua ou cancele antes de excluir.')
    const { data: po } = await supabaseAdmin.from('production_order').select('id')
      .eq('organization_id', orgId).eq('part_id', partId).not('status', 'in', '(disponivel,cancelado)').limit(1).maybeSingle()
    if (po) throw new BadRequestException('Existe uma ordem de produção em andamento para esta peça — conclua ou cancele antes de excluir.')
    const { error } = await supabaseAdmin.from('product_dev_part').delete().eq('id', partId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao excluir: ${error.message}`)
    return { deleted: true }
  }

  private async getPart(orgId: string, partId: string): Promise<PartRef & { product_dev_id: string }> {
    const { data, error } = await supabaseAdmin.from('product_dev_part').select('*')
      .eq('id', partId).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Peça não encontrada')
    return data as PartRef & { product_dev_id: string }
  }

  // ══ Versões da peça (reusa product_dev_version com part_id) ═════════
  async listPartVersions(orgId: string, partId: string) {
    const { data, error } = await supabaseAdmin.from('product_dev_version').select('*')
      .eq('organization_id', orgId).eq('part_id', partId).order('version_number', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  /** Normaliza a composição da bandeja: [{part_id, units int ≥1}] ou null. */
  private normalizeComposition(raw: unknown): Array<{ part_id: string; units: number }> | null {
    if (!Array.isArray(raw)) return null
    const comp = (raw as Array<{ part_id?: string; units?: number }>)
      .filter(c => c && typeof c.part_id === 'string' && Number(c.units) > 0)
      .map(c => ({ part_id: c.part_id as string, units: Math.max(1, Math.round(Number(c.units))) }))
    return comp.length ? comp : null
  }

  async addPartVersion(orgId: string, partId: string, userId: string | null, body: {
    changelog?: string; file_url?: string; file_type?: string; material?: string
    weight_g?: number; print_time_minutes?: number; volume_cm3?: number; prototype_photo_urls?: string[]; notes?: string
    filaments?: Array<{ index: number; material: string | null; color: string | null; weight_g: number }> | null
    plate_composition?: Array<{ part_id: string; units: number }> | null
  }) {
    const part = await this.getPart(orgId, partId)
    const existing = await this.listPartVersions(orgId, partId) as Array<{ version_number: number }>
    const nextNumber = existing.length ? Number(existing[0].version_number) + 1 : 1
    const { data, error } = await supabaseAdmin.from('product_dev_version').insert({
      organization_id: orgId, product_dev_id: part.product_dev_id, part_id: partId, version_number: nextNumber,
      changelog: body.changelog ?? null, file_url: body.file_url ?? null, file_type: body.file_type ?? null,
      material: body.material ?? null, weight_g: body.weight_g ?? null, print_time_minutes: body.print_time_minutes ?? null,
      volume_cm3: body.volume_cm3 ?? null, prototype_photo_urls: body.prototype_photo_urls ?? [], status: 'rascunho',
      filaments: body.filaments && body.filaments.length ? body.filaments : null,
      plate_composition: this.normalizeComposition(body.plate_composition),
      notes: body.notes ?? null, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar versão da peça: ${error?.message ?? 'sem dados'}`)
    return data
  }

  /** BANDEJAS do produto: versões (de qualquer peça) com composição — 1
   *  bandeja = 1 arquivo fatiado que rende N unidades de ≥1 peça por
   *  impressão. Peso/tempo da versão valem PELA BANDEJA inteira. */
  async listPlates(orgId: string, devId: string) {
    const parts = await this.listParts(orgId, devId) as unknown as Array<PartRef & { code: string | null }>
    const byId = new Map(parts.map(p => [p.id, p]))
    const { data, error } = await supabaseAdmin.from('product_dev_version').select('*')
      .eq('organization_id', orgId).eq('product_dev_id', devId)
      .not('part_id', 'is', null).not('plate_composition', 'is', null)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const plates = []
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const comp = this.normalizeComposition(row.plate_composition) ?? []
      if (!comp.length) continue
      const named = comp.map(c => ({
        ...c, name: byId.get(c.part_id)?.name ?? '(peça removida)',
        code: (byId.get(c.part_id) as { code?: string | null } | undefined)?.code ?? null,
      }))
      plates.push({
        version_id: row.id, part_id: row.part_id,   // peça âncora (dona da versão)
        anchor_name: byId.get(row.part_id as string)?.name ?? '(peça removida)',
        version_number: row.version_number, changelog: row.changelog ?? null,
        material: row.material ?? null, weight_g: row.weight_g ?? null,
        print_time_minutes: row.print_time_minutes ?? null,
        file_url: row.file_url ?? null, sliced_file_url: row.sliced_file_url ?? null,
        approved: row.approved === true, filaments: row.filaments ?? null,
        composition: named, units_total: named.reduce((s, c) => s + c.units, 0),
        created_at: row.created_at,
      })
    }
    return plates
  }

  /** Métricas de fabricação da peça: versão aprovada > última. Peça SEM
   *  versão própria mas presente numa BANDEJA de outra peça (ex: plaqueta
   *  que imprime junto das pernas) herda os números da bandeja. */
  private async resolvePartMetrics(orgId: string, partId: string): Promise<PartVersionMetrics> {
    const versions = await this.listPartVersions(orgId, partId) as Array<{ approved: boolean; weight_g: number | null; print_time_minutes: number | null; material: string | null; plate_composition: Array<{ part_id?: string; units?: number }> | null }>
    let ref = versions.find(v => v.approved) ?? versions[0]
    if (!ref) {
      // sem versão própria: procura a bandeja (versão de OUTRA peça deste
      // produto) que contém esta peça na composição — aprovada > mais recente
      const part = await this.getPart(orgId, partId)
      const { data } = await supabaseAdmin.from('product_dev_version')
        .select('approved, weight_g, print_time_minutes, material, plate_composition')
        .eq('organization_id', orgId).eq('product_dev_id', part.product_dev_id)
        .not('plate_composition', 'is', null).order('created_at', { ascending: false })
      const hosts = ((data ?? []) as typeof versions).filter(v =>
        Array.isArray(v.plate_composition) &&
        v.plate_composition.some(c => c?.part_id === partId && Number(c?.units) > 0))
      ref = hosts.find(v => v.approved) ?? hosts[0]
    }
    // bandeja com composição: peso/tempo da versão valem PELA BANDEJA — divide
    // pelo total de unidades pra virar custo POR PEÇA (aproximação: rateio
    // uniforme entre as peças da bandeja; suficiente pro custo, que fecha no
    // produto porque a soma das partes reconstrói a bandeja inteira)
    const comp = Array.isArray(ref?.plate_composition) ? ref!.plate_composition!.filter(c => c && Number(c.units) > 0) : []
    const totalUnits = comp.reduce((s, c) => s + Math.max(1, Math.round(Number(c.units) || 1)), 0)
    const div = totalUnits > 1 ? totalUnits : 1
    const per = (v: number | null | undefined) => v != null ? Math.round((Number(v) / div) * 100) / 100 : null
    return { weight_g: per(ref?.weight_g), print_time_minutes: per(ref?.print_time_minutes), material: ref?.material ?? null }
  }

  // ══ Estoque de peças prontas (ledger) ══════════════════════════════
  async listPartMovements(orgId: string, partId: string) {
    const { data, error } = await supabaseAdmin.from('product_dev_part_movement').select('*')
      .eq('organization_id', orgId).eq('part_id', partId).order('created_at', { ascending: false }).limit(100)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  /** Crédito de peças prontas ao concluir a OP da peça. Idempotente por OP. */
  async creditFromOrder(orgId: string, partId: string, qty: number, orderId: string, userId: string | null): Promise<void> {
    const q = Math.max(0, Number(qty) || 0)
    if (q <= 0) return
    const { data: done } = await supabaseAdmin.from('product_dev_part_movement').select('id')
      .eq('part_id', partId).eq('reference_type', 'production_order').eq('reference_id', orderId).eq('movement_type', 'produced').maybeSingle()
    if (done) return
    const part = await this.getPart(orgId, partId)
    const novo = this.round2(Number(part.stock_qty) + q)
    await supabaseAdmin.from('product_dev_part').update({ stock_qty: novo, updated_at: new Date().toISOString() }).eq('id', partId)
    await supabaseAdmin.from('product_dev_part_movement').insert({
      organization_id: orgId, part_id: partId, movement_type: 'produced', quantity: q, balance_after: novo,
      reference_type: 'production_order', reference_id: orderId, notes: 'Peças prontas (conclusão da OP)', created_by: userId,
    })
    this.logger.log(`[peca] +${q} prontas em ${partId.slice(0, 8)} (estoque=${novo})`)
  }

  /** Saída de peças prontas pra SAC/reposição/uso avulso (baixa N do estoque com motivo). */
  async partStockOut(orgId: string, partId: string, qty: number, reason: string, userId: string | null) {
    const q = Math.max(0, Number(qty) || 0)
    if (q <= 0) throw new BadRequestException('Quantidade inválida')
    const part = await this.getPart(orgId, partId)
    const disponivel = this.round2(Number(part.stock_qty) - Number(part.reserved_qty))
    if (q > disponivel) throw new BadRequestException(`Só há ${disponivel} peça(s) disponível(is) (fora as reservadas).`)
    const novo = this.round2(Number(part.stock_qty) - q)
    await supabaseAdmin.from('product_dev_part').update({ stock_qty: novo, updated_at: new Date().toISOString() }).eq('id', partId).eq('organization_id', orgId)
    await supabaseAdmin.from('product_dev_part_movement').insert({
      organization_id: orgId, part_id: partId, movement_type: 'consume', quantity: q, balance_after: novo,
      reference_type: 'sac', reference_id: null, notes: reason?.trim() || 'Saída p/ reposição/SAC', created_by: userId,
    })
    this.logger.log(`[peca] -${q} saída SAC/reposição em ${partId.slice(0, 8)} (estoque=${novo})`)
    return { ...part, stock_qty: novo }
  }

  /** Ajuste manual do estoque de peças (define o valor absoluto). */
  async adjustStock(orgId: string, partId: string, newQty: number, userId: string | null) {
    const part = await this.getPart(orgId, partId)
    const novo = Math.max(0, Number(newQty) || 0)
    await supabaseAdmin.from('product_dev_part').update({ stock_qty: novo, updated_at: new Date().toISOString() }).eq('id', partId).eq('organization_id', orgId)
    await supabaseAdmin.from('product_dev_part_movement').insert({
      organization_id: orgId, part_id: partId, movement_type: 'adjust', quantity: novo, balance_after: novo,
      reference_type: 'manual', reference_id: null, notes: 'Ajuste manual de estoque', created_by: userId,
    })
    return { ...part, stock_qty: novo }
  }

  private async reservePart(orgId: string, partId: string, qty: number, refType: string, refId: string): Promise<boolean> {
    const q = Math.max(0, Number(qty) || 0)
    if (q <= 0) return false
    const { data: existing } = await supabaseAdmin.from('product_dev_part_movement').select('id')
      .eq('part_id', partId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve').maybeSingle()
    if (existing) return true
    const part = await this.getPart(orgId, partId)
    await supabaseAdmin.from('product_dev_part').update({ reserved_qty: this.round2(Number(part.reserved_qty) + q), updated_at: new Date().toISOString() }).eq('id', partId)
    await supabaseAdmin.from('product_dev_part_movement').insert({
      organization_id: orgId, part_id: partId, movement_type: 'reserve', quantity: q,
      reference_type: refType, reference_id: refId, notes: 'Reserva p/ montagem',
    })
    return true
  }

  private async releaseParts(orgId: string, refType: string, refId: string): Promise<void> {
    const { data: reserves } = await supabaseAdmin.from('product_dev_part_movement').select('part_id, quantity')
      .eq('organization_id', orgId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve')
    for (const rm of (reserves ?? []) as Array<{ part_id: string; quantity: number }>) {
      const { data: released } = await supabaseAdmin.from('product_dev_part_movement').select('id')
        .eq('part_id', rm.part_id).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'release').maybeSingle()
      if (released) continue
      const { data: part } = await supabaseAdmin.from('product_dev_part').select('reserved_qty').eq('id', rm.part_id).maybeSingle()
      if (!part) continue
      const novaRes = Math.max(0, this.round2(Number((part as { reserved_qty: number }).reserved_qty) - Number(rm.quantity)))
      await supabaseAdmin.from('product_dev_part').update({ reserved_qty: novaRes, updated_at: new Date().toISOString() }).eq('id', rm.part_id)
      await supabaseAdmin.from('product_dev_part_movement').insert({
        organization_id: orgId, part_id: rm.part_id, movement_type: 'release', quantity: Number(rm.quantity),
        reference_type: refType, reference_id: refId, notes: 'Liberação de reserva (cancelamento)',
      })
    }
  }

  private async consumeParts(orgId: string, refType: string, refId: string): Promise<void> {
    const { data: reserves } = await supabaseAdmin.from('product_dev_part_movement').select('part_id, quantity')
      .eq('organization_id', orgId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve')
    for (const rm of (reserves ?? []) as Array<{ part_id: string; quantity: number }>) {
      const { data: consumed } = await supabaseAdmin.from('product_dev_part_movement').select('id')
        .eq('part_id', rm.part_id).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'consume').maybeSingle()
      if (consumed) continue
      const { data: part } = await supabaseAdmin.from('product_dev_part').select('stock_qty, reserved_qty').eq('id', rm.part_id).maybeSingle()
      if (!part) continue
      const reserved = Number(rm.quantity)
      const novaQtd = Math.max(0, this.round2(Number((part as { stock_qty: number }).stock_qty) - reserved))
      const novaRes = Math.max(0, this.round2(Number((part as { reserved_qty: number }).reserved_qty) - reserved))
      await supabaseAdmin.from('product_dev_part').update({ stock_qty: novaQtd, reserved_qty: novaRes, updated_at: new Date().toISOString() }).eq('id', rm.part_id)
      await supabaseAdmin.from('product_dev_part_movement').insert({
        organization_id: orgId, part_id: rm.part_id, movement_type: 'consume', quantity: reserved, balance_after: novaQtd,
        reference_type: refType, reference_id: refId, notes: 'Consumo na montagem',
      })
    }
  }

  /** Reservas ativas por peça (reserve sem release/consume), com o nº da montagem que segura cada uma. */
  private async activeReservations(partIds: string[]): Promise<Map<string, Array<{ assembly_id: string; order_number: number | null; qty: number }>>> {
    const out = new Map<string, Array<{ assembly_id: string; order_number: number | null; qty: number }>>()
    if (!partIds.length) return out
    const { data: movs } = await supabaseAdmin.from('product_dev_part_movement')
      .select('part_id, quantity, movement_type, reference_id')
      .in('part_id', partIds).eq('reference_type', 'assembly_order').in('movement_type', ['reserve', 'release', 'consume'])
    const net = new Map<string, number>()
    for (const m of (movs ?? []) as Array<{ part_id: string; quantity: number; movement_type: string; reference_id: string }>) {
      const key = `${m.part_id}|${m.reference_id}`
      const sign = m.movement_type === 'reserve' ? 1 : -1
      net.set(key, this.round2((net.get(key) ?? 0) + sign * Number(m.quantity)))
    }
    const active = [...net.entries()].filter(([, q]) => q > 0)
    if (!active.length) return out
    const asmIds = [...new Set(active.map(([k]) => k.split('|')[1]))]
    const { data: asms } = await supabaseAdmin.from('assembly_order').select('id, order_number').in('id', asmIds)
    const numbers = new Map((asms ?? []).map(a => [(a as { id: string }).id, (a as { order_number: number }).order_number]))
    for (const [key, q] of active) {
      const [partId, asmId] = key.split('|')
      const list = out.get(partId) ?? []
      list.push({ assembly_id: asmId, order_number: numbers.get(asmId) ?? null, qty: q })
      out.set(partId, list)
    }
    return out
  }

  // ══ Montagem (assembly) ════════════════════════════════════════════
  /** Prévia: o que montar X produtos consome de peças + insumos, com faltas. */
  async previewAssembly(orgId: string, devId: string, quantity: number) {
    const qty = Math.max(1, Math.floor(Number(quantity) || 0))
    const parts = await this.listParts(orgId, devId) as Array<PartRef & { available: number; is_optional: boolean }>
    if (!parts.length) throw new BadRequestException('Este produto não tem peças cadastradas. Cadastre as peças primeiro.')
    const reservedBy = await this.activeReservations(parts.filter(p => Number(p.reserved_qty) > 0).map(p => p.id))
    const partLines = parts.map(p => {
      const needed = this.round2(Number(p.qty_per_product) * qty)
      return { type: 'peca', part_id: p.id, name: p.name, needed, available: p.available, unit: 'un', is_optional: p.is_optional, sufficient: p.available >= needed, missing: Math.max(0, this.round2(needed - p.available)), reserved: this.round2(Number(p.reserved_qty)), reserved_by: reservedBy.get(p.id) ?? [] }
    })
    // insumos de montagem: linhas de BOM do produto que NÃO são filamento (embalagem/etiqueta/mão de obra)
    const { data: bom } = await supabaseAdmin.from('product_dev_bom').select('input_id, kind, description, quantity, waste_pct')
      .eq('organization_id', orgId).eq('product_dev_id', devId).is('version_id', null)
    const insumoNeed = new Map<string, number>()
    for (const l of (bom ?? []) as Array<{ input_id: string | null; kind: string; quantity: number; waste_pct: number }>) {
      if (!l.input_id || l.kind === 'filamento' || Number(l.quantity) <= 0) continue
      const need = Number(l.quantity) * qty * (1 + Number(l.waste_pct) / 100)
      insumoNeed.set(l.input_id, (insumoNeed.get(l.input_id) ?? 0) + need)
    }
    const insumoLines: Array<{ type: string; input_id: string; name: string; needed: number; available: number; unit: string; sufficient: boolean; missing: number }> = []
    if (insumoNeed.size) {
      const { data: inputs } = await supabaseAdmin.from('production_input').select('id, name, unit, quantity, reserved_quantity').in('id', [...insumoNeed.keys()])
      const map = new Map((inputs ?? []).map(i => [(i as { id: string }).id, i as { id: string; name: string; unit: string; quantity: number; reserved_quantity: number }]))
      for (const [id, need] of insumoNeed) {
        const i = map.get(id)
        const available = i ? this.round2(Number(i.quantity) - Number(i.reserved_quantity)) : 0
        insumoLines.push({ type: 'insumo', input_id: id, name: i?.name ?? '(insumo removido)', needed: this.round2(need), available, unit: i?.unit ?? 'un', sufficient: !!i && available >= need, missing: Math.max(0, this.round2(need - available)) })
      }
    }
    const required = partLines.filter(l => !l.is_optional)
    return {
      quantity: qty, parts: partLines, insumos: insumoLines,
      all_sufficient: required.every(l => l.sufficient) && insumoLines.every(l => l.sufficient),
      missing_parts: partLines.filter(l => !l.is_optional && !l.sufficient).map(l => ({ part_id: l.part_id, name: l.name, missing: l.missing })),
    }
  }

  async listAssemblies(orgId: string, opts: { product_dev_id?: string; status?: string } = {}) {
    let q = supabaseAdmin.from('assembly_order').select('*').eq('organization_id', orgId).order('created_at', { ascending: false })
    if (opts.product_dev_id) q = q.eq('product_dev_id', opts.product_dev_id)
    if (opts.status) q = q.eq('status', opts.status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async getAssembly(orgId: string, aid: string) {
    const { data, error } = await supabaseAdmin.from('assembly_order').select('*').eq('id', aid).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Montagem não encontrada')
    return data
  }

  /** Cria a montagem: exige peças/insumos suficientes (senão erro com a falta) e reserva tudo. */
  async createAssembly(orgId: string, devId: string, userId: string | null, quantity: number) {
    const qty = Math.max(1, Math.floor(Number(quantity) || 0))
    const preview = await this.previewAssembly(orgId, devId, qty)
    if (!preview.all_sufficient) {
      const faltas = [
        ...preview.parts.filter(l => !l.is_optional && !l.sufficient).map(l => `${l.name} (faltam ${l.missing}${l.reserved_by.length ? `; ${l.reserved} já reservada(s) p/ ${l.reserved_by.map(r => `Montagem #${r.order_number ?? '?'}`).join(', ')}` : ''})`),
        ...preview.insumos.filter(l => !l.sufficient).map(l => `${l.name} (faltam ${l.missing} ${l.unit})`),
      ].join(', ')
      throw new BadRequestException(`Estoque insuficiente p/ montar ${qty}: ${faltas}. Gere as OPs de impressão das peças que faltam ou reponha os insumos.`)
    }
    const { data: seq } = await supabaseAdmin.from('assembly_order').select('order_number')
      .eq('organization_id', orgId).order('order_number', { ascending: false }).limit(1).maybeSingle()
    const nextNumber = seq ? Number((seq as { order_number: number }).order_number) + 1 : 1
    const { data, error } = await supabaseAdmin.from('assembly_order').insert({
      organization_id: orgId, product_dev_id: devId, order_number: nextNumber, quantity: qty, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar montagem: ${error?.message ?? 'sem dados'}`)
    const asm = data as { id: string }
    // reserva peças + insumos de montagem. Peça OPCIONAL sem saldo não entra
    // (o preview só valida as obrigatórias — reservar opcional sem estoque
    // deixaria reserved_qty > stock_qty no ledger de peças).
    for (const l of preview.parts) {
      if (l.is_optional && !l.sufficient) continue
      await this.reservePart(orgId, l.part_id, l.needed, 'assembly_order', asm.id)
    }
    for (const l of preview.insumos) await this.inputs.reserveInput(orgId, l.input_id, l.needed, 'assembly_order', asm.id)
    await this.emit(orgId, devId, 'assembly_created' as string, { assembly_order_id: asm.id, qty }, userId)
    return this.getAssembly(orgId, asm.id)
  }

  async transitionAssembly(orgId: string, aid: string, to: string, userId: string | null) {
    const asm = await this.getAssembly(orgId, aid) as { id: string; status: string; product_dev_id: string; quantity: number; stock_movement_done: boolean }
    const from = asm.status
    if (from === to) return asm
    const allowed = ASSEMBLY_TRANSITIONS[from] ?? []
    if (!allowed.includes(to)) throw new BadRequestException(`Transição inválida: '${from}' → '${to}'`)
    const patch: Record<string, unknown> = { status: to }
    if (to === 'montando' && !(asm as { started_at?: string }).started_at) patch.started_at = new Date().toISOString()
    if (to === 'disponivel' || to === 'concluido') patch.completed_at = new Date().toISOString()
    // compare-and-swap: dois cliques simultâneos não consomem/creditam 2×
    const { data: updated } = await supabaseAdmin.from('assembly_order').update(patch)
      .eq('id', aid).eq('organization_id', orgId).eq('status', from).select('id')
    if (!updated?.length) throw new BadRequestException('A montagem mudou de status em outra aba/clique — recarregue e tente de novo.')

    if (to === 'cancelado') {
      await this.releaseParts(orgId, 'assembly_order', aid)
      await this.inputs.release(orgId, 'assembly_order', aid)
    }
    // embalado: o produto foi montado → consome as peças prontas + insumos de montagem
    if (to === 'embalado') {
      await this.consumeParts(orgId, 'assembly_order', aid)
      await this.inputs.consume(orgId, 'assembly_order', aid)
      await this.emit(orgId, asm.product_dev_id, 'assembly_packed' as string, { assembly_order_id: aid, qty: asm.quantity }, userId)
    }
    // disponível: produto pronto p/ venda → credita estoque vendável
    if (to === 'disponivel') {
      await this.creditProductStock(orgId, asm)
      await this.emit(orgId, asm.product_dev_id, 'assembly_completed' as string, { assembly_order_id: aid, qty: asm.quantity }, userId)
    }
    // legado: montagens antigas que iam direto p/ 'concluido' (consome + credita)
    if (to === 'concluido') {
      await this.consumeParts(orgId, 'assembly_order', aid)
      await this.inputs.consume(orgId, 'assembly_order', aid)
      await this.creditProductStock(orgId, asm)
      await this.emit(orgId, asm.product_dev_id, 'assembly_completed' as string, { assembly_order_id: aid, qty: asm.quantity }, userId)
    }
    return this.getAssembly(orgId, aid)
  }

  /** Credita os produtos montados no ESTOQUE UNIFICADO via StockService
   *  (applyProductionRestock): cria a linha mestre se faltar, grava movimento
   *  idempotente por montagem e propaga products.stock/canais. */
  private async creditProductStock(orgId: string, asm: { id: string; product_dev_id: string; quantity: number; stock_movement_done: boolean }) {
    if (asm.stock_movement_done === true) return
    const { data: dev } = await supabaseAdmin.from('product_dev').select('product_id').eq('id', asm.product_dev_id).eq('organization_id', orgId).maybeSingle()
    const productId = (dev as { product_id: string | null } | null)?.product_id
    await supabaseAdmin.from('assembly_order').update({ stock_movement_done: true }).eq('id', asm.id)
    if (!productId) { this.logger.log(`[montagem] ${asm.id.slice(0, 8)} concluída sem produto cadastrado — sem crédito de estoque vendável`); return }
    const qty = Number(asm.quantity) || 0
    const res = await this.stock.applyProductionRestock({
      productId, quantity: qty, refId: `assembly:${asm.id}`,
      note: 'Montagem concluída — Product OS',
    })
    this.logger.log(`[montagem] +${qty} un montadas no ledger (${res}) p/ ${productId.slice(0, 8)}`)
  }

  // ══ Custo somado: peças + insumos de montagem ══════════════════════
  async costFromParts(orgId: string, devId: string, body: { target_margin_pct?: number } = {}) {
    const parts = await this.listParts(orgId, devId) as Array<PartRef>
    if (!parts.length) throw new BadRequestException('Sem peças cadastradas.')
    const { data: settings } = await supabaseAdmin.from('production_settings')
      .select('filament_cost_per_kg, energy_cost_per_hour, labor_cost_per_hour, packaging_cost').eq('organization_id', orgId).maybeSingle()
    const s = (settings ?? {}) as { filament_cost_per_kg?: Record<string, number>; energy_cost_per_hour?: number; labor_cost_per_hour?: number; packaging_cost?: number }
    const filamentKg = s.filament_cost_per_kg ?? {}
    const energyRate = Number(s.energy_cost_per_hour) || 0, laborRate = Number(s.labor_cost_per_hour) || 0, pkg = Number(s.packaging_cost) || 0

    const partLines: Array<{ part_id: string; name: string; qty_per_product: number; weight_g: number | null; print_minutes: number | null; unit_cost: number; line_cost: number; has_version: boolean }> = []
    for (const p of parts) {
      const m = await this.resolvePartMetrics(orgId, p.id)
      const mat = (m.material ?? '').toUpperCase()
      const filCost = m.weight_g != null ? (Number(m.weight_g) / 1000) * (Number(filamentKg[mat]) || 0) : 0
      const time = Number(m.print_time_minutes) || 0
      const unitCost = this.round2(filCost + (time / 60) * energyRate + (time / 60) * laborRate)
      const lineCost = this.round2(unitCost * Number(p.qty_per_product))
      partLines.push({ part_id: p.id, name: p.name, qty_per_product: Number(p.qty_per_product), weight_g: m.weight_g, print_minutes: m.print_time_minutes, unit_cost: unitCost, line_cost: lineCost, has_version: m.weight_g != null || m.print_time_minutes != null })
    }
    // insumos de montagem (BOM não-filamento, custo médio vivo)
    const { data: bom } = await supabaseAdmin.from('product_dev_bom').select('input_id, kind, description, quantity, unit_cost, waste_pct')
      .eq('organization_id', orgId).eq('product_dev_id', devId).is('version_id', null)
    const inputIds = (bom ?? []).map(l => (l as { input_id: string | null }).input_id).filter(Boolean) as string[]
    const costByInput = new Map<string, number>()
    if (inputIds.length) {
      const { data: inputs } = await supabaseAdmin.from('production_input').select('id, cost_per_unit').in('id', inputIds)
      for (const i of inputs ?? []) costByInput.set((i as { id: string }).id, Number((i as { cost_per_unit: number }).cost_per_unit) || 0)
    }
    const insumoLines = ((bom ?? []) as Array<{ input_id: string | null; kind: string; description: string | null; quantity: number; unit_cost: number; waste_pct: number }>)
      .filter(l => l.kind !== 'filamento' && Number(l.quantity) > 0)
      .map(l => {
        const uc = l.input_id && costByInput.has(l.input_id) ? (costByInput.get(l.input_id) as number) : Number(l.unit_cost)
        return { kind: l.kind, description: l.description, quantity: Number(l.quantity), unit_cost: uc, line_cost: this.round2(Number(l.quantity) * uc * (1 + Number(l.waste_pct) / 100)) }
      })

    const partsTotal = this.round2(partLines.reduce((a, l) => a + l.line_cost, 0))
    const insumosTotal = this.round2(insumoLines.reduce((a, l) => a + l.line_cost, 0))
    const total = this.round2(partsTotal + insumosTotal + pkg)

    const targetMargin = Math.min(Math.max(Number(body.target_margin_pct ?? 30), 0), 90)
    const suggested = Object.entries(CHANNEL_ALLIN_FEE_PCT).map(([channel, fee]) => {
      const denom = 1 - fee / 100 - targetMargin / 100
      const price = denom > 0 ? this.round2(total / denom) : 0
      const marginPct = price > 0 ? this.round2(((price - price * fee / 100 - total) / price) * 100) : 0
      return { channel, fee_pct: fee, price, margin_pct: marginPct }
    })
    await supabaseAdmin.from('product_dev').update({ estimated_cost: total }).eq('id', devId).eq('organization_id', orgId)
    return {
      cost: { total, parts_total: partsTotal, insumos_total: insumosTotal, packaging: this.round2(pkg) },
      parts: partLines, insumos: insumoLines, missing_versions: partLines.filter(l => !l.has_version).map(l => l.name),
      target_margin_pct: targetMargin, suggested_prices: suggested,
    }
  }

  // ══ #1 — IA sugere as peças (a partir do briefing, ou gera do zero) ═
  async suggestParts(orgId: string, devId: string): Promise<{ source: 'briefing' | 'ia'; suggestions: Array<{ name: string; qty_per_product: number; is_optional: boolean; width_mm: number | null; depth_mm: number | null; height_mm: number | null; rationale: string }> }> {
    const { data: dev } = await supabaseAdmin.from('product_dev').select('name, category, description, briefing')
      .eq('id', devId).eq('organization_id', orgId).maybeSingle()
    if (!dev) throw new NotFoundException('Produto não encontrado')
    const d = dev as { name: string; category: string | null; description: string | null; briefing: Record<string, unknown> | null }

    // 1. o briefing já costuma trazer os MÓDULOS prontos (nome/qtd/dimensões) → reusa sem gastar IA
    const modulos = Array.isArray((d.briefing as { modulos?: unknown[] } | null)?.modulos) ? ((d.briefing as { modulos: Array<Record<string, unknown>> }).modulos) : []
    if (modulos.length) {
      const suggestions = modulos.map(m => {
        const p = (m.params ?? {}) as Record<string, unknown>
        const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null }
        return {
          name: String(m.nome ?? 'Peça').trim(), qty_per_product: Math.max(1, Number(m.quantidade) || 1), is_optional: false,
          width_mm: num(p.largura_mm), depth_mm: num(p.profundidade_mm), height_mm: num(p.altura_mm),
          rationale: [m.tipo, m.cor].filter(Boolean).join(' · ') || 'do briefing',
        }
      }).filter(s => s.name)
      if (suggestions.length) return { source: 'briefing', suggestions }
    }

    // 2. sem briefing → IA propõe a divisão
    const out = await this.llm.generateText({
      orgId, feature: 'product_os_parts_suggest', jsonMode: true, maxTokens: 1200, temperature: 0.3,
      systemPrompt: 'Você é engenheiro de produto p/ impressão 3D FDM (mesa ~256×256mm). Divida o produto em PEÇAS imprimíveis separadas (que encaixam/montam). Peças grandes (>250mm) viram módulos. Responda SOMENTE JSON.',
      userPrompt: `Produto: ${d.name}\nCategoria: ${d.category ?? '—'}\nDescrição: ${d.description ?? '—'}\n\nResponda JSON:\n{ "parts": [ { "name": "ex: Base", "qty_per_product": número, "width_mm": número_ou_null, "depth_mm": número_ou_null, "height_mm": número_ou_null, "rationale": "por que é uma peça separada" } ] }\nSe o produto é naturalmente 1 peça só, devolva 1 item.`,
    })
    const parsed = parseJsonLoosePart(out.text) as { parts?: Array<Record<string, unknown>> } | null
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null }
    const suggestions = (parsed?.parts ?? []).map(p => ({
      name: String(p.name ?? '').trim(), qty_per_product: Math.max(1, Number(p.qty_per_product) || 1), is_optional: false,
      width_mm: num(p.width_mm), depth_mm: num(p.depth_mm), height_mm: num(p.height_mm), rationale: String(p.rationale ?? '').trim(),
    })).filter(s => s.name)
    return { source: 'ia', suggestions }
  }

  // ══ #2 — Plano de pratos (quantas peças cabem por bandeja) ══════════
  async platePlan(orgId: string, devId: string, quantity: number) {
    const qty = Math.max(1, Math.floor(Number(quantity) || 1))
    const parts = await this.listParts(orgId, devId) as Array<PartRef & { width_mm: number | null; depth_mm: number | null; height_mm: number | null }>
    if (!parts.length) throw new BadRequestException('Sem peças cadastradas.')
    // mesa: maior impressora ativa, senão A1 (256×256×256)
    const { data: printers } = await supabaseAdmin.from('production_printer').select('name, build_volume_mm, status').eq('organization_id', orgId).eq('status', 'ativa')
    const beds = (printers ?? []).map(p => ({ name: (p as { name: string }).name, ...parseBed((p as { build_volume_mm: string | null }).build_volume_mm) }))
    const bed = beds.sort((a, b) => b.x * b.y - a.x * a.y)[0] ?? { name: 'Padrão A1', x: 256, y: 256, z: 256 }
    const GAP = 5 // folga entre peças (mm)

    const lines = []
    for (const p of parts) {
      const m = await this.resolvePartMetrics(orgId, p.id)
      const needed = Math.ceil(Number(p.qty_per_product) * qty)
      const w = Number(p.width_mm) || 0, dep = Number(p.depth_mm) || 0, h = Number(p.height_mm) || 0
      let perPlate: number | null = null, fitNote = ''
      if (w > 0 && dep > 0) {
        if (h > 0 && h > bed.z) { perPlate = 0; fitNote = `peça (${h}mm) mais alta que a mesa (${bed.z}mm)` }
        else {
          // grade simples nas 2 orientações (gira 90°), pega a melhor
          const grid = (a: number, b: number) => Math.max(0, Math.floor((bed.x + GAP) / (a + GAP))) * Math.max(0, Math.floor((bed.y + GAP) / (b + GAP)))
          perPlate = Math.max(grid(w, dep), grid(dep, w))
          if (perPlate === 0) fitNote = `peça (${w}×${dep}mm) maior que a mesa (${bed.x}×${bed.y}mm)`
        }
      }
      const plates = perPlate && perPlate > 0 ? Math.ceil(needed / perPlate) : null
      const minutesPerUnit = Number(m.print_time_minutes) || 0
      lines.push({
        part_id: p.id, name: p.name, qty_per_product: Number(p.qty_per_product), needed,
        width_mm: p.width_mm, depth_mm: p.depth_mm, height_mm: p.height_mm,
        per_plate: perPlate, plates, fit_note: fitNote || null,
        plate_minutes: perPlate && perPlate > 0 && minutesPerUnit > 0 ? Math.round(minutesPerUnit * Math.min(perPlate, needed)) : null,
        has_dims: w > 0 && dep > 0,
      })
    }
    const totalPlates = lines.reduce((s, l) => s + (l.plates ?? 0), 0)
    return {
      quantity: qty, bed, gap_mm: GAP, lines,
      total_plates: totalPlates, missing_dims: lines.filter(l => !l.has_dims).map(l => l.name),
      note: 'Estimativa por grade (peças iguais no mesmo prato). O encaixe fino de peças diferentes juntas é feito no Bambu Studio. Agrupar reduz trocas de prato, não o tempo total de impressão.',
    }
  }
}

/** Parse "256x256x256" / "256 × 256 × 256" / "180x180" → {x,y,z}. Default A1. */
function parseBed(s: string | null): { x: number; y: number; z: number } {
  const nums = String(s ?? '').match(/\d+(?:[.,]\d+)?/g)?.map(n => Number(n.replace(',', '.'))) ?? []
  return { x: nums[0] || 256, y: nums[1] || nums[0] || 256, z: nums[2] || 256 }
}

/** Parse tolerante de JSON de LLM (igual aos outros serviços do módulo). */
function parseJsonLoosePart(text: string): unknown {
  const t = (text ?? '').trim()
  try { return JSON.parse(t) } catch { /* */ }
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (m) { try { return JSON.parse(m[1]) } catch { /* */ } }
  const o = t.indexOf('{'), c = t.lastIndexOf('}')
  if (o >= 0 && c > o) { try { return JSON.parse(t.slice(o, c + 1)) } catch { /* */ } }
  return null
}
