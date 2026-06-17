import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export type LocationType = 'picking' | 'pulmao' | 'staging' | 'devolucao'
export type SlotSource = 'manual' | 'import' | 'capture' | 'abc'
/** Padrões de endereçamento suportados (o cliente escolhe qual usar). */
export type AddressScheme = 'coluna_estante_nivel' | 'rua_estante_nivel_posicao'
export const DEFAULT_ADDRESS_SCHEME: AddressScheme = 'coluna_estante_nivel'

export interface WarehouseLocation {
  id: string
  warehouse_id: string
  code: string
  coluna: string | null     // padrão 1: letra estilo Excel (A,B,C…); a coluna É o setor/fila
  setor: string | null      // padrão 1: nome do setor da coluna (ex.: "Pendentes") — opcional
  rua: number | null        // padrão 2
  estante: number | null
  nivel: number | null
  posicao: number | null    // padrão 2
  sequence: number
  location_type: LocationType
  is_active: boolean
}

/**
 * Endereçamento de estoque (WMS slotting) — Fase 1.
 *
 * Dá endereço físico aos produtos no CD (Rua-Estante-Nível-Posição) para a lista de
 * coleta (individual e em ondas) dizer ONDE pegar cada item e ordenar a coleta como
 * ROTA (campo `sequence`). Popular o mapa por 3 caminhos: importar planilha,
 * aprender-na-coleta (capture-on-pick) e sugestão por curva ABC.
 *
 * NÃO controla quantidade por posição (melhoria futura — estoque por endereço).
 */
@Injectable()
export class FulfillmentLocationsService {
  private readonly logger = new Logger(FulfillmentLocationsService.name)

  // ── Helpers de endereço (suporta os 2 padrões) ───────────────────────────────
  /** Letra(s) da coluna → número (A=1 … Z=26, AA=27 …). Infinito. */
  private colToNum(coluna: string): number {
    let n = 0
    for (const ch of coluna.toUpperCase()) { const c = ch.charCodeAt(0) - 64; if (c < 1 || c > 26) break; n = n * 26 + c }
    return n
  }
  /** Número → letra(s) da coluna (1=A … 27=AA …). */
  private numToCol(n: number): string {
    let s = ''
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
    return s || 'A'
  }
  /** Padrão 1: A1-N1 = Coluna A, Estante 1, Nível 1. */
  private buildCodeColuna(coluna: string, estante: number, nivel: number): string {
    return `${coluna.toUpperCase()}${estante}-N${nivel}`
  }
  private seqColuna(coluna: string, estante: number, nivel: number): number {
    return this.colToNum(coluna) * 1_000_000 + estante * 1_000 + nivel
  }
  /** Padrão 2: R02-E05-N3-P01. */
  private buildCodeRua(rua: number, estante: number, nivel: number, posicao: number): string {
    const p2 = (n: number) => String(n).padStart(2, '0')
    return `R${p2(rua)}-E${p2(estante)}-N${nivel}-P${p2(posicao)}`
  }
  private seqRua(rua: number, estante: number, nivel: number, posicao: number): number {
    return rua * 1_000_000 + estante * 10_000 + nivel * 100 + posicao
  }
  /** Auto-detecta o padrão a partir do código e devolve partes + sequence. */
  private parseCode(code: string): { scheme: AddressScheme; coluna: string | null; rua: number | null; estante: number; nivel: number; posicao: number | null; sequence: number } | null {
    const c = (code ?? '').trim().toUpperCase()
    const m1 = /^([A-Z]+)(\d+)-N(\d+)$/.exec(c)              // A1-N1
    if (m1) {
      const coluna = m1[1], estante = Number(m1[2]), nivel = Number(m1[3])
      return { scheme: 'coluna_estante_nivel', coluna, rua: null, estante, nivel, posicao: null, sequence: this.seqColuna(coluna, estante, nivel) }
    }
    const m2 = /^R(\d+)-E(\d+)-N(\d+)-P(\d+)$/.exec(c)        // R02-E05-N3-P01
    if (m2) {
      const rua = Number(m2[1]), estante = Number(m2[2]), nivel = Number(m2[3]), posicao = Number(m2[4])
      return { scheme: 'rua_estante_nivel_posicao', coluna: null, rua, estante, nivel, posicao, sequence: this.seqRua(rua, estante, nivel, posicao) }
    }
    return null
  }
  private normalizeCode(code: string): string {
    return (code ?? '').trim().toUpperCase()
  }

  // ── Padrão escolhido pelo cliente (fulfillment_settings.settings.address_scheme) ──
  async getScheme(orgId: string): Promise<AddressScheme> {
    const { data } = await supabaseAdmin.from('fulfillment_settings').select('settings').eq('organization_id', orgId).maybeSingle()
    const s = (data as { settings?: { address_scheme?: string } } | null)?.settings?.address_scheme
    return (s === 'rua_estante_nivel_posicao' || s === 'coluna_estante_nivel') ? s : DEFAULT_ADDRESS_SCHEME
  }
  async setScheme(orgId: string, scheme: AddressScheme): Promise<{ ok: true; scheme: AddressScheme }> {
    if (scheme !== 'coluna_estante_nivel' && scheme !== 'rua_estante_nivel_posicao') throw new BadRequestException('Padrão de endereçamento inválido.')
    const { data } = await supabaseAdmin.from('fulfillment_settings').select('settings').eq('organization_id', orgId).maybeSingle()
    const settings = { ...((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}), address_scheme: scheme }
    const { error } = await supabaseAdmin.from('fulfillment_settings')
      .upsert({ organization_id: orgId, settings, updated_at: new Date().toISOString() }, { onConflict: 'organization_id' })
    if (error) throw new BadRequestException(`Erro ao salvar padrão: ${error.message}`)
    return { ok: true, scheme }
  }

  // ── CRUD de endereços ───────────────────────────────────────────────────────
  async listLocations(orgId: string, warehouseId?: string): Promise<WarehouseLocation[]> {
    let q = supabaseAdmin.from('warehouse_locations').select('*').eq('organization_id', orgId)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId)
    const { data } = await q.order('sequence', { ascending: true }).order('code', { ascending: true }).limit(5000)
    return (data ?? []) as WarehouseLocation[]
  }

  async createLocation(orgId: string, input: { warehouseId: string; code?: string; coluna?: string; setor?: string; rua?: number; estante?: number; nivel?: number; posicao?: number; type?: LocationType }): Promise<{ ok: true; id: string }> {
    if (!input.warehouseId) throw new BadRequestException('Informe o CD (warehouseId).')
    const row = this.locationRowFromInput(orgId, input)
    const { data, error } = await supabaseAdmin.from('warehouse_locations').insert(row).select('id').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar endereço: ${error?.message ?? '?'}`)
    return { ok: true, id: (data as { id: string }).id }
  }

  /** Monta a linha de endereço a partir do código (auto-detecta o padrão) ou das partes. */
  private locationRowFromInput(orgId: string, input: { warehouseId: string; code?: string; coluna?: string; setor?: string; rua?: number; estante?: number; nivel?: number; posicao?: number; type?: LocationType }): Record<string, unknown> {
    const base = { organization_id: orgId, warehouse_id: input.warehouseId, location_type: input.type ?? 'picking' }
    // 1) veio o código → auto-detecta o padrão
    if (input.code) {
      const p = this.parseCode(input.code)
      if (!p) throw new BadRequestException('Código inválido. Use A1-N1 (coluna-estante-nível) ou R02-E05-N3-P01.')
      return { ...base, code: this.normalizeCode(input.code), coluna: p.coluna, setor: input.setor ?? null, rua: p.rua, estante: p.estante, nivel: p.nivel, posicao: p.posicao, sequence: p.sequence }
    }
    // 2) veio coluna+estante+nível → padrão 1 (A1-N1)
    if (input.coluna && input.estante != null && input.nivel != null) {
      const coluna = input.coluna.toUpperCase()
      return { ...base, code: this.buildCodeColuna(coluna, input.estante, input.nivel), coluna, setor: input.setor ?? null, rua: null, estante: input.estante, nivel: input.nivel, posicao: null, sequence: this.seqColuna(coluna, input.estante, input.nivel) }
    }
    // 3) veio rua+estante+nível+posição → padrão 2 (R02-E05-N3-P01)
    if (input.rua != null && input.estante != null && input.nivel != null && input.posicao != null) {
      return { ...base, code: this.buildCodeRua(input.rua, input.estante, input.nivel, input.posicao), coluna: null, setor: null, rua: input.rua, estante: input.estante, nivel: input.nivel, posicao: input.posicao, sequence: this.seqRua(input.rua, input.estante, input.nivel, input.posicao) }
    }
    throw new BadRequestException('Informe o código (A1-N1 ou R02-E05-N3-P01) ou as partes do endereço.')
  }

  async updateLocation(orgId: string, id: string, patch: { is_active?: boolean; type?: LocationType; sequence?: number }): Promise<{ ok: true }> {
    const row: Record<string, unknown> = {}
    if (patch.is_active !== undefined) row.is_active = patch.is_active
    if (patch.type !== undefined) row.location_type = patch.type
    if (patch.sequence !== undefined) row.sequence = patch.sequence
    if (Object.keys(row).length) {
      const { error } = await supabaseAdmin.from('warehouse_locations').update(row).eq('id', id).eq('organization_id', orgId)
      if (error) throw new BadRequestException(`Erro ao atualizar endereço: ${error.message}`)
    }
    return { ok: true }
  }

  async deleteLocation(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin.from('warehouse_locations').delete().eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao remover endereço: ${error.message}`)
    return { ok: true }
  }

  /** Gera a malha de endereços de uma vez (ranges), no padrão escolhido. Idempotente. */
  async generateGrid(orgId: string, input: {
    warehouseId: string
    scheme?: AddressScheme
    // padrão 1 (coluna-estante-nível): colFrom/colTo são letras (A..E); setores opcional
    colFrom?: string; colTo?: string; setores?: Record<string, string>
    // padrão 2 (rua-estante-nível-posição)
    ruaFrom?: number; ruaTo?: number; posicaoFrom?: number; posicaoTo?: number
    // comum
    estanteFrom: number; estanteTo: number; nivelFrom: number; nivelTo: number
    type?: LocationType
  }): Promise<{ ok: true; created: number; skipped: number }> {
    if (!input.warehouseId) throw new BadRequestException('Informe o CD (warehouseId).')
    const scheme = input.scheme ?? await this.getScheme(orgId)
    const type = input.type ?? 'picking'
    const rng = (a: number, b: number) => { const lo = Math.min(a, b), hi = Math.max(a, b); return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) }
    const rows: Record<string, unknown>[] = []
    if (scheme === 'coluna_estante_nivel') {
      const cFrom = this.colToNum(input.colFrom || 'A') || 1
      const cTo = this.colToNum(input.colTo || input.colFrom || 'A') || cFrom
      for (const cn of rng(cFrom, cTo)) {
        const coluna = this.numToCol(cn)
        const setor = input.setores?.[coluna] ?? null
        for (const estante of rng(input.estanteFrom, input.estanteTo))
          for (const nivel of rng(input.nivelFrom, input.nivelTo))
            rows.push({ organization_id: orgId, warehouse_id: input.warehouseId, code: this.buildCodeColuna(coluna, estante, nivel), coluna, setor, rua: null, estante, nivel, posicao: null, sequence: this.seqColuna(coluna, estante, nivel), location_type: type })
      }
    } else {
      for (const rua of rng(input.ruaFrom ?? 1, input.ruaTo ?? 1))
        for (const estante of rng(input.estanteFrom, input.estanteTo))
          for (const nivel of rng(input.nivelFrom, input.nivelTo))
            for (const posicao of rng(input.posicaoFrom ?? 1, input.posicaoTo ?? 1))
              rows.push({ organization_id: orgId, warehouse_id: input.warehouseId, code: this.buildCodeRua(rua, estante, nivel, posicao), coluna: null, setor: null, rua, estante, nivel, posicao, sequence: this.seqRua(rua, estante, nivel, posicao), location_type: type })
    }
    if (rows.length === 0) return { ok: true, created: 0, skipped: 0 }
    if (rows.length > 20000) throw new BadRequestException('Malha muito grande (máx. 20.000 endereços por vez). Reduza os intervalos.')

    // já existentes (pula)
    const codes = rows.map((r) => r.code as string)
    const existing = new Set<string>()
    for (let i = 0; i < codes.length; i += 500) {
      const { data } = await supabaseAdmin.from('warehouse_locations').select('code')
        .eq('organization_id', orgId).eq('warehouse_id', input.warehouseId).in('code', codes.slice(i, i + 500))
      for (const r of (data ?? []) as Array<{ code: string }>) existing.add(r.code)
    }
    const toInsert = rows.filter((r) => !existing.has(r.code as string))
    let created = 0
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabaseAdmin.from('warehouse_locations').insert(toInsert.slice(i, i + 500))
      if (error) throw new BadRequestException(`Erro ao gerar malha: ${error.message}`)
      created += Math.min(500, toInsert.length - i)
    }
    return { ok: true, created, skipped: rows.length - created }
  }

  /** Nomeia o setor de uma coluna inteira (padrão 1). Ex.: coluna A = "Pendentes". */
  async setSector(orgId: string, warehouseId: string, coluna: string, setor: string | null): Promise<{ ok: true }> {
    const col = (coluna ?? '').toUpperCase()
    if (!col) throw new BadRequestException('Informe a coluna (letra).')
    const { error } = await supabaseAdmin.from('warehouse_locations')
      .update({ setor: setor || null }).eq('organization_id', orgId).eq('warehouse_id', warehouseId).eq('coluna', col)
    if (error) throw new BadRequestException(`Erro ao nomear setor: ${error.message}`)
    return { ok: true }
  }

  // ── Vínculo produto ↔ endereço ──────────────────────────────────────────────
  /** Onde está um produto (lista os endereços vinculados). */
  async productLocations(orgId: string, productId: string) {
    const { data } = await supabaseAdmin.from('product_locations')
      .select('id, is_primary, source, warehouse_locations(id, code, sequence, warehouse_id, location_type)')
      .eq('organization_id', orgId).eq('product_id', productId)
    return (data ?? []) as unknown[]
  }

  /** O que tem num endereço (lista os produtos). */
  async locationProducts(orgId: string, locationId: string) {
    const { data } = await supabaseAdmin.from('product_locations')
      .select('id, is_primary, source, product_id, products(sku, name, abc_class)')
      .eq('organization_id', orgId).eq('location_id', locationId)
    return (data ?? []) as unknown[]
  }

  /** Acha ou cria o endereço pelo código (no CD). */
  private async ensureLocationByCode(orgId: string, warehouseId: string, code: string): Promise<WarehouseLocation> {
    const norm = this.normalizeCode(code)
    if (!norm) throw new BadRequestException('Código de endereço vazio.')
    const { data: found } = await supabaseAdmin.from('warehouse_locations').select('*')
      .eq('organization_id', orgId).eq('warehouse_id', warehouseId).eq('code', norm).maybeSingle()
    if (found) return found as WarehouseLocation
    const row = this.locationRowFromInput(orgId, { warehouseId, code: norm })
    const { data: created, error } = await supabaseAdmin.from('warehouse_locations').insert(row).select('*').maybeSingle()
    if (error || !created) {
      // corrida: re-seleciona
      const { data: again } = await supabaseAdmin.from('warehouse_locations').select('*')
        .eq('organization_id', orgId).eq('warehouse_id', warehouseId).eq('code', norm).maybeSingle()
      if (again) return again as WarehouseLocation
      throw new BadRequestException(`Erro ao criar endereço ${norm}: ${error?.message ?? '?'}`)
    }
    return created as WarehouseLocation
  }

  /** Vincula um produto a um endereço (por código). is_primary=true demove os outros. */
  async assignProduct(orgId: string, input: { productId: string; warehouseId: string; code: string; isPrimary?: boolean; source?: SlotSource }): Promise<{ ok: true; locationId: string; code: string }> {
    if (!input.productId) throw new BadRequestException('Informe o produto.')
    const loc = await this.ensureLocationByCode(orgId, input.warehouseId, input.code)
    const isPrimary = input.isPrimary ?? true
    if (isPrimary) {
      await supabaseAdmin.from('product_locations').update({ is_primary: false })
        .eq('organization_id', orgId).eq('product_id', input.productId)
    }
    const { error } = await supabaseAdmin.from('product_locations').upsert({
      organization_id: orgId, product_id: input.productId, location_id: loc.id,
      is_primary: isPrimary, source: input.source ?? 'manual', updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id,product_id,location_id' })
    if (error) throw new BadRequestException(`Erro ao vincular produto: ${error.message}`)
    // propaga o endereço pras tarefas de coleta pendentes desse produto no CD
    await this.backfillPendingPickTasks(orgId, input.warehouseId, input.productId, loc)
    return { ok: true, locationId: loc.id, code: loc.code }
  }

  async unassignProduct(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin.from('product_locations').delete().eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao remover vínculo: ${error.message}`)
    return { ok: true }
  }

  /** Importação em massa: linhas {sku, code}. Cria endereços que faltam + vincula (primary). */
  async bulkImport(orgId: string, warehouseId: string, rows: Array<{ sku: string; code: string }>): Promise<{ ok: true; linked: number; skippedNoProduct: string[]; total: number }> {
    if (!warehouseId) throw new BadRequestException('Informe o CD (warehouseId).')
    const clean = (rows ?? []).map((r) => ({ sku: String(r.sku ?? '').trim(), code: this.normalizeCode(r.code) })).filter((r) => r.sku && r.code)
    if (clean.length === 0) throw new BadRequestException('Nada para importar (esperado linhas com SKU e endereço).')
    // resolve SKU → product_id
    const skus = [...new Set(clean.map((r) => r.sku))]
    const skuToProduct = await this.skuToProductId(orgId, skus)
    let linked = 0
    const skippedNoProduct: string[] = []
    for (const r of clean) {
      const pid = skuToProduct.get(r.sku)
      if (!pid) { skippedNoProduct.push(r.sku); continue }
      try {
        await this.assignProduct(orgId, { productId: pid, warehouseId, code: r.code, isPrimary: true, source: 'import' })
        linked++
      } catch (e) {
        this.logger.warn(`[locations] import falhou p/ SKU ${r.sku}: ${(e as Error).message}`)
      }
    }
    return { ok: true, linked, skippedNoProduct: [...new Set(skippedNoProduct)], total: clean.length }
  }

  /** Capture-on-pick: bipou a prateleira de um item sem endereço → grava o vínculo. */
  async setLocationForPickTask(orgId: string, pickTaskId: string, code: string): Promise<{ ok: true; code: string }> {
    const { data: task } = await supabaseAdmin.from('pick_tasks')
      .select('id, sku, product_id, warehouse_id').eq('id', pickTaskId).eq('organization_id', orgId).maybeSingle()
    if (!task) throw new NotFoundException('Tarefa de coleta não encontrada.')
    const t = task as { id: string; sku: string; product_id: string | null; warehouse_id: string }
    let productId = t.product_id
    if (!productId) productId = (await this.skuToProductId(orgId, [t.sku])).get(t.sku) ?? null
    const loc = await this.ensureLocationByCode(orgId, t.warehouse_id, code)
    if (productId) {
      // grava o vínculo permanente (aprende pra próxima)
      await this.assignProduct(orgId, { productId, warehouseId: t.warehouse_id, code: loc.code, isPrimary: true, source: 'capture' })
    } else {
      // produto fora do catálogo: grava só nesta tarefa (one-off)
      await supabaseAdmin.from('pick_tasks').update({ location_id: loc.id, location_code: loc.code, location_seq: loc.sequence })
        .eq('id', pickTaskId).eq('organization_id', orgId)
    }
    return { ok: true, code: loc.code }
  }

  /** Atualiza o endereço das tarefas de coleta pendentes de um produto no CD. */
  private async backfillPendingPickTasks(orgId: string, warehouseId: string, productId: string, loc: WarehouseLocation): Promise<void> {
    const { data: prod } = await supabaseAdmin.from('products').select('sku').eq('id', productId).eq('organization_id', orgId).maybeSingle()
    const sku = (prod as { sku: string | null } | null)?.sku
    const patch = { location_id: loc.id, location_code: loc.code, location_seq: loc.sequence }
    // por product_id
    await supabaseAdmin.from('pick_tasks').update(patch)
      .eq('organization_id', orgId).eq('warehouse_id', warehouseId).eq('product_id', productId)
      .in('status', ['pending', 'in_progress'])
    // por sku (pedidos de marketplace não têm product_id)
    if (sku) {
      await supabaseAdmin.from('pick_tasks').update(patch)
        .eq('organization_id', orgId).eq('warehouse_id', warehouseId).eq('sku', sku).is('product_id', null)
        .in('status', ['pending', 'in_progress'])
    }
  }

  // ── Sugestão por curva ABC ───────────────────────────────────────────────────
  /** Sugere endereços (de picking livres) priorizando giro alto (classe A) perto da
   *  expedição (menor sequence). Determinístico. `apply` grava os vínculos sugeridos. */
  async abcSuggest(orgId: string, warehouseId: string, opts?: { apply?: boolean; limit?: number }): Promise<{ ok: true; suggestions: Array<{ productId: string; sku: string | null; name: string | null; abc: string | null; code: string; locationId: string }>; applied: number }> {
    if (!warehouseId) throw new BadRequestException('Informe o CD (warehouseId).')
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000)
    // produtos da org SEM endereço, ordenados por classe ABC (A→B→C→sem)
    const { data: prods } = await supabaseAdmin.from('products')
      .select('id, sku, name, abc_class').eq('organization_id', orgId).order('abc_class', { ascending: true }).limit(3000)
    const allProds = (prods ?? []) as Array<{ id: string; sku: string | null; name: string | null; abc_class: string | null }>
    const { data: links } = await supabaseAdmin.from('product_locations').select('product_id').eq('organization_id', orgId)
    const linked = new Set((links ?? []).map((r) => (r as { product_id: string }).product_id))
    const rank = (c: string | null) => (c === 'A' ? 0 : c === 'B' ? 1 : c === 'C' ? 2 : 3)
    const pending = allProds.filter((p) => !linked.has(p.id)).sort((a, b) => rank(a.abc_class) - rank(b.abc_class)).slice(0, limit)

    // endereços de picking livres (sem produto), em ordem de rota
    const { data: locs } = await supabaseAdmin.from('warehouse_locations')
      .select('id, code, sequence').eq('organization_id', orgId).eq('warehouse_id', warehouseId)
      .eq('location_type', 'picking').eq('is_active', true).order('sequence', { ascending: true }).limit(5000)
    const allLocs = (locs ?? []) as Array<{ id: string; code: string; sequence: number }>
    const occupied = new Set((await supabaseAdmin.from('product_locations')
      .select('location_id').eq('organization_id', orgId)).data?.map((r) => (r as { location_id: string }).location_id) ?? [])
    const freeLocs = allLocs.filter((l) => !occupied.has(l.id))

    const suggestions: Array<{ productId: string; sku: string | null; name: string | null; abc: string | null; code: string; locationId: string }> = []
    for (let i = 0; i < pending.length && i < freeLocs.length; i++) {
      suggestions.push({ productId: pending[i].id, sku: pending[i].sku, name: pending[i].name, abc: pending[i].abc_class, code: freeLocs[i].code, locationId: freeLocs[i].id })
    }

    let applied = 0
    if (opts?.apply) {
      for (const s of suggestions) {
        try { await this.assignProduct(orgId, { productId: s.productId, warehouseId, code: s.code, isPrimary: true, source: 'abc' }); applied++ }
        catch (e) { this.logger.warn(`[locations] abc apply falhou ${s.sku}: ${(e as Error).message}`) }
      }
    }
    return { ok: true, suggestions, applied }
  }

  // ── Lookup p/ a ingestão (seed) e telas ─────────────────────────────────────
  /** Mapa SKU → endereço principal (no CD). Usado pelo seed() pra carimbar pick_tasks. */
  async lookupLocationsBySku(orgId: string, warehouseId: string, skus: string[]): Promise<Map<string, { id: string; code: string; seq: number }>> {
    const map = new Map<string, { id: string; code: string; seq: number }>()
    const unique = [...new Set(skus.filter(Boolean))]
    if (unique.length === 0 || !warehouseId) return map
    const skuToPid = await this.skuToProductId(orgId, unique)
    const pids = [...new Set([...skuToPid.values()])]
    if (pids.length === 0) return map
    const { data } = await supabaseAdmin.from('product_locations')
      .select('product_id, is_primary, warehouse_locations(id, code, sequence, warehouse_id)')
      .eq('organization_id', orgId).in('product_id', pids).eq('is_primary', true)
    const pidToLoc = new Map<string, { id: string; code: string; seq: number }>()
    type WL = { id: string; code: string; sequence: number; warehouse_id: string }
    const rows = (data ?? []) as unknown as Array<{ product_id: string; warehouse_locations: WL | WL[] | null }>
    for (const r of rows) {
      const wl = Array.isArray(r.warehouse_locations) ? r.warehouse_locations[0] : r.warehouse_locations
      if (wl && wl.warehouse_id === warehouseId) pidToLoc.set(r.product_id, { id: wl.id, code: wl.code, seq: Number(wl.sequence) })
    }
    for (const [sku, pid] of skuToPid.entries()) {
      const loc = pidToLoc.get(pid)
      if (loc) map.set(sku, loc)
    }
    return map
  }

  private async skuToProductId(orgId: string, skus: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    const unique = [...new Set(skus.filter(Boolean))]
    for (let i = 0; i < unique.length; i += 300) {
      const { data } = await supabaseAdmin.from('products').select('id, sku')
        .eq('organization_id', orgId).in('sku', unique.slice(i, i + 300))
      for (const r of (data ?? []) as Array<{ id: string; sku: string | null }>) {
        if (r.sku && !map.has(r.sku)) map.set(r.sku, r.id)
      }
    }
    return map
  }
}
