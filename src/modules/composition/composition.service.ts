import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { StockService } from '../stock/stock.service'

/** Item da composição de um kit. */
export interface CompositionItem {
  component_product_id: string
  quantity: number
  // enriquecidos na leitura:
  name?: string | null
  sku?: string | null
  price?: number | null
  stock?: number | null
  thumbnail?: string | null
}

/** Item de NF-e/invoice antes da explosão. */
export interface InvoiceLine {
  product_id?: string | null
  sku?: string | null
  description?: string | null
  qty: number
  unit_value?: number | null
}

/** Composição (kit operacional) — CRUD + explosão pra NF-e.
 *
 *  A MECÂNICA de estoque (venda do kit baixa componentes; estoque do kit =
 *  min(componente ÷ qtd)) vive no StockService — aqui só o cadastro, as
 *  validações de 1 nível e o exploder de itens pra faturamento. */
@Injectable()
export class CompositionService {
  private readonly logger = new Logger(CompositionService.name)

  constructor(private readonly stock: StockService) {}

  // ── Leitura ────────────────────────────────────────────────────────────

  /** Todos os kits da org com seus componentes enriquecidos. */
  async listKits(orgId: string): Promise<Array<{
    kit_product_id: string
    name: string | null
    sku: string | null
    stock: number | null
    thumbnail: string | null
    components: CompositionItem[]
  }>> {
    const { data, error } = await supabaseAdmin
      .from('product_components')
      .select('kit_product_id, component_product_id, quantity')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: true })
    if (error) throw new BadRequestException(`listKits: ${error.message}`)

    const rows = (data ?? []) as Array<{ kit_product_id: string; component_product_id: string; quantity: number }>
    if (rows.length === 0) return []

    const ids = [...new Set(rows.flatMap(r => [r.kit_product_id, r.component_product_id]))]
    const prods = await this.fetchProductsMap(orgId, ids)

    const byKit = new Map<string, CompositionItem[]>()
    for (const r of rows) {
      const arr = byKit.get(r.kit_product_id) ?? []
      const p = prods.get(r.component_product_id)
      arr.push({
        component_product_id: r.component_product_id,
        quantity: Number(r.quantity),
        name: p?.name ?? null, sku: p?.sku ?? null, price: p?.price ?? null,
        stock: p?.stock ?? null, thumbnail: p?.thumbnail ?? null,
      })
      byKit.set(r.kit_product_id, arr)
    }

    return [...byKit.entries()].map(([kitId, components]) => {
      const k = prods.get(kitId)
      return {
        kit_product_id: kitId,
        name: k?.name ?? null, sku: k?.sku ?? null,
        stock: k?.stock ?? null, thumbnail: k?.thumbnail ?? null,
        components,
      }
    })
  }

  /** Composição de 1 produto (vazio = não é kit). */
  async getComposition(orgId: string, productId: string): Promise<CompositionItem[]> {
    const { data, error } = await supabaseAdmin
      .from('product_components')
      .select('component_product_id, quantity')
      .eq('organization_id', orgId)
      .eq('kit_product_id', productId)
    if (error) throw new BadRequestException(`getComposition: ${error.message}`)
    const rows = (data ?? []) as Array<{ component_product_id: string; quantity: number }>
    if (rows.length === 0) return []

    const prods = await this.fetchProductsMap(orgId, rows.map(r => r.component_product_id))
    return rows.map(r => {
      const p = prods.get(r.component_product_id)
      return {
        component_product_id: r.component_product_id,
        quantity: Number(r.quantity),
        name: p?.name ?? null, sku: p?.sku ?? null, price: p?.price ?? null,
        stock: p?.stock ?? null, thumbnail: p?.thumbnail ?? null,
      }
    })
  }

  // ── Escrita ────────────────────────────────────────────────────────────

  /** Define (substitui) a composição do produto. items vazio = deixa de ser kit.
   *  Regras: componentes da mesma org; sem auto-referência; 1 NÍVEL só
   *  (componente não pode ser kit; o kit não pode ser componente de outro). */
  async setComposition(
    orgId: string,
    kitProductId: string,
    items: Array<{ component_product_id: string; quantity: number }>,
  ): Promise<{ ok: true; components: number; derived_stock: number | null }> {
    // produto existe na org?
    const { data: kit } = await supabaseAdmin
      .from('products').select('id, name')
      .eq('organization_id', orgId).eq('id', kitProductId).maybeSingle()
    if (!kit) throw new NotFoundException('Produto (kit) não encontrado.')

    const clean = (items ?? [])
      .filter(i => i?.component_product_id)
      .map(i => ({ component_product_id: i.component_product_id, quantity: Number(i.quantity) }))

    for (const i of clean) {
      if (!Number.isFinite(i.quantity) || i.quantity <= 0) {
        throw new BadRequestException('Quantidade de cada componente deve ser maior que zero.')
      }
      if (i.component_product_id === kitProductId) {
        throw new BadRequestException('Um produto não pode ser componente de si mesmo.')
      }
    }
    const dupCheck = new Set(clean.map(i => i.component_product_id))
    if (dupCheck.size !== clean.length) {
      throw new BadRequestException('Componente repetido na composição.')
    }

    if (clean.length > 0) {
      // componentes existem na org?
      const { data: comps } = await supabaseAdmin
        .from('products').select('id')
        .eq('organization_id', orgId)
        .in('id', clean.map(i => i.component_product_id))
      const found = new Set((comps ?? []).map(c => c.id as string))
      const missing = clean.filter(i => !found.has(i.component_product_id))
      if (missing.length) throw new BadRequestException('Componente não encontrado no catálogo desta organização.')

      // 1 nível: componente não pode ter composição própria
      const { data: nested } = await supabaseAdmin
        .from('product_components')
        .select('kit_product_id')
        .eq('organization_id', orgId)
        .in('kit_product_id', clean.map(i => i.component_product_id))
        .limit(1)
      if ((nested ?? []).length > 0) {
        throw new BadRequestException('Um componente não pode ser ele mesmo um kit (composição tem 1 nível só).')
      }

      // 1 nível: este kit não pode ser componente de outro kit
      const { data: usedAsComponent } = await supabaseAdmin
        .from('product_components')
        .select('kit_product_id')
        .eq('organization_id', orgId)
        .eq('component_product_id', kitProductId)
        .limit(1)
      if ((usedAsComponent ?? []).length > 0) {
        throw new BadRequestException('Este produto já é componente de outro kit — não pode virar kit (1 nível só).')
      }
    }

    // substitui atomicamente (delete + insert)
    const { error: delErr } = await supabaseAdmin
      .from('product_components')
      .delete()
      .eq('organization_id', orgId)
      .eq('kit_product_id', kitProductId)
    if (delErr) throw new BadRequestException(`setComposition.delete: ${delErr.message}`)

    if (clean.length > 0) {
      const { error: insErr } = await supabaseAdmin
        .from('product_components')
        .insert(clean.map(i => ({
          organization_id: orgId,
          kit_product_id: kitProductId,
          component_product_id: i.component_product_id,
          quantity: i.quantity,
        })))
      if (insErr) throw new BadRequestException(`setComposition.insert: ${insErr.message}`)
    }

    // recalcula o derivado e propaga pros anúncios do kit
    let derived: number | null = null
    try {
      derived = await this.stock.syncKitDerivedStock(kitProductId)
      await this.stock.recalcAndPropagate(kitProductId, 'composition_update')
    } catch (e) {
      this.logger.warn(`[composition] recalc pós-set ${kitProductId}: ${(e as Error)?.message}`)
    }

    this.logger.log(`[composition] kit=${kitProductId} componentes=${clean.length} derivado=${derived ?? '—'}`)
    return { ok: true, components: clean.length, derived_stock: derived }
  }

  // ── Explosão pra NF-e / faturamento ────────────────────────────────────
  //
  // Recebe linhas de invoice (sku ou product_id + qty + valor unitário) e
  // devolve as linhas com kits EXPLODIDOS em componentes: quantidade =
  // qty_da_linha × qtd_no_kit; valor rateado proporcional ao preço de
  // catálogo dos componentes (total da linha preservado — o último componente
  // absorve diferença de arredondamento). Linhas sem composição passam direto.
  // É AQUI que a emissão real de NF-e (Faturador F2b-3) deve plugar, ANTES de
  // montar make.tagProd().

  async explodeForInvoice(orgId: string, lines: InvoiceLine[]): Promise<Array<InvoiceLine & {
    from_kit_product_id?: string
    from_kit_sku?: string | null
  }>> {
    if (!lines?.length) return []

    // resolve product_id por SKU quando preciso
    const skusToResolve = lines.filter(l => !l.product_id && l.sku).map(l => String(l.sku))
    const bySku = new Map<string, { id: string; name: string | null; sku: string | null; price: number | null }>()
    if (skusToResolve.length) {
      const { data } = await supabaseAdmin
        .from('products').select('id, name, sku, price')
        .eq('organization_id', orgId)
        .in('sku', skusToResolve)
      for (const p of (data ?? []) as Array<{ id: string; name: string | null; sku: string | null; price: number | null }>) {
        if (p.sku) bySku.set(p.sku, p)
      }
    }

    const out: Array<InvoiceLine & { from_kit_product_id?: string; from_kit_sku?: string | null }> = []
    for (const line of lines) {
      const pid = line.product_id ?? (line.sku ? bySku.get(String(line.sku))?.id ?? null : null)
      const comps = pid ? await this.getComposition(orgId, pid) : []

      if (!pid || comps.length === 0) { out.push({ ...line }); continue }

      const kitSku = line.sku ?? bySku.get(String(line.sku ?? ''))?.sku ?? null
      const lineQty = Number(line.qty) || 0
      const lineTotal = line.unit_value != null ? Math.round(Number(line.unit_value) * lineQty * 100) / 100 : null

      // pesos do rateio = preço de catálogo × qtd (fallback: igualitário)
      const weights = comps.map(c => Math.max(0, Number(c.price ?? 0)) * c.quantity)
      const wSum = weights.reduce((a, b) => a + b, 0)

      let allocated = 0
      comps.forEach((c, idx) => {
        const compQty = lineQty * c.quantity
        let compTotal: number | null = null
        if (lineTotal != null) {
          if (idx === comps.length - 1) {
            compTotal = Math.round((lineTotal - allocated) * 100) / 100 // absorve arredondamento
          } else {
            const share = wSum > 0 ? weights[idx] / wSum : 1 / comps.length
            compTotal = Math.round(lineTotal * share * 100) / 100
            allocated = Math.round((allocated + compTotal) * 100) / 100
          }
        }
        out.push({
          product_id: c.component_product_id,
          sku: c.sku ?? null,
          description: c.name ?? null,
          qty: compQty,
          unit_value: compTotal != null && compQty > 0 ? Math.round((compTotal / compQty) * 10000) / 10000 : null,
          from_kit_product_id: pid,
          from_kit_sku: kitSku,
        })
      })
    }
    return out
  }

  // ── Busca de produtos (pra UI montar composição) ───────────────────────

  async searchProducts(orgId: string, q: string, limit = 20): Promise<Array<{
    id: string; name: string | null; sku: string | null; price: number | null
    stock: number | null; thumbnail: string | null; is_kit: boolean
  }>> {
    let qb = supabaseAdmin
      .from('products')
      .select('id, name, sku, price, stock, photo_urls')
      .eq('organization_id', orgId)
      .order('name', { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 50))
    if (q?.trim()) qb = qb.or(`name.ilike.%${q.trim()}%,sku.ilike.%${q.trim()}%`)
    const { data, error } = await qb
    if (error) throw new BadRequestException(`searchProducts: ${error.message}`)
    const rows = (data ?? []) as Array<{ id: string; name: string | null; sku: string | null; price: number | null; stock: number | null; photo_urls: string[] | null }>
    if (rows.length === 0) return []

    const { data: kitRows } = await supabaseAdmin
      .from('product_components')
      .select('kit_product_id')
      .eq('organization_id', orgId)
      .in('kit_product_id', rows.map(r => r.id))
    const kitIds = new Set((kitRows ?? []).map(r => r.kit_product_id as string))

    return rows.map(r => ({
      id: r.id, name: r.name, sku: r.sku, price: r.price, stock: r.stock,
      thumbnail: r.photo_urls?.[0] ?? null,
      is_kit: kitIds.has(r.id),
    }))
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async fetchProductsMap(orgId: string, ids: string[]): Promise<Map<string, {
    name: string | null; sku: string | null; price: number | null; stock: number | null; thumbnail: string | null
  }>> {
    const map = new Map<string, { name: string | null; sku: string | null; price: number | null; stock: number | null; thumbnail: string | null }>()
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabaseAdmin
        .from('products')
        .select('id, name, sku, price, stock, photo_urls')
        .eq('organization_id', orgId)
        .in('id', ids.slice(i, i + 200))
      for (const p of (data ?? []) as Array<{ id: string; name: string | null; sku: string | null; price: number | null; stock: number | null; photo_urls: string[] | null }>) {
        map.set(p.id, { name: p.name, sku: p.sku, price: p.price, stock: p.stock, thumbnail: p.photo_urls?.[0] ?? null })
      }
    }
    return map
  }
}
