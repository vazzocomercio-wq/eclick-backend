import { Injectable, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { getEffectivePrice } from '../store-config/store-config.service'

/**
 * Variantes de cor/acabamento — Provador IA (PV1).
 *
 * Cada cor é um produto separado (a cor vive no nome/SKU). Esta camada liga
 * produtos que são variantes uns dos outros. O vínculo é DIRECIONAL (base ->
 * variante) e definido pelo lojista no editor de produto do catálogo.
 *
 * A sugestão é por RAIZ de SKU (mesmo tronco, final diferente = cor) e NUNCA
 * cria vínculo sozinha — só devolve candidatos pro lojista confirmar.
 */

interface ProductRow {
  id: string; name: string; sku: string | null
  price: number | null; sale_price: number | null
  sale_start_at: string | null; sale_end_at: string | null
  photo_urls: string[] | null; stock: number | null; storefront_visible: boolean | null
}

export interface VariantView {
  productId: string
  name:      string
  sku:       string | null
  label:     string | null
  imageUrl:  string | null
  price:     number
  available: boolean
}

export interface VariantSuggestion {
  productId:    string
  name:         string
  sku:          string | null
  suggestLabel: string | null   // sufixo do SKU que difere (provável cor)
  imageUrl:     string | null
}

const PROD_COLS = 'id, name, sku, price, sale_price, sale_start_at, sale_end_at, photo_urls, stock, storefront_visible'

@Injectable()
export class StorefrontVariantsService {
  // ── Lojista ──────────────────────────────────────────────────────────────

  /** Variantes vinculadas a um produto base (com snapshot do produto). */
  async listForBase(orgId: string, baseProductId: string): Promise<VariantView[]> {
    const { data: links } = await supabaseAdmin
      .from('storefront_product_variants')
      .select('variant_product_id, label, position')
      .eq('organization_id', orgId)
      .eq('base_product_id', baseProductId)
      .order('position', { ascending: true })
    const rows = (links ?? []) as Array<{ variant_product_id: string; label: string | null; position: number }>
    if (rows.length === 0) return []
    const prods = await this.fetchProducts(orgId, rows.map(r => r.variant_product_id))
    const now = Date.now()
    return rows
      .map(r => {
        const p = prods.get(r.variant_product_id)
        if (!p) return null
        return this.toView(p, r.label, now)
      })
      .filter((v): v is VariantView => v !== null)
  }

  /** Substitui o conjunto de variantes do produto base (direcional). */
  async setForBase(
    orgId: string,
    baseProductId: string,
    items: Array<{ variantProductId: string; label?: string | null }>,
  ): Promise<{ ok: true; count: number }> {
    if (!baseProductId) throw new BadRequestException('baseProductId obrigatório')
    // Limpa os vínculos atuais do base
    await supabaseAdmin
      .from('storefront_product_variants')
      .delete()
      .eq('organization_id', orgId)
      .eq('base_product_id', baseProductId)

    const clean = items
      .filter(i => i.variantProductId && i.variantProductId !== baseProductId)
      .filter((i, idx, arr) => arr.findIndex(x => x.variantProductId === i.variantProductId) === idx)
    if (clean.length === 0) return { ok: true, count: 0 }

    const rows = clean.map((i, idx) => ({
      organization_id:    orgId,
      base_product_id:    baseProductId,
      variant_product_id: i.variantProductId,
      label:              (i.label ?? '').trim() || null,
      position:           idx,
    }))
    const { error } = await supabaseAdmin.from('storefront_product_variants').insert(rows)
    if (error) throw new BadRequestException(`Erro ao salvar variantes: ${error.message}`)
    return { ok: true, count: rows.length }
  }

  /** Sugere variantes por RAIZ de SKU (mesmo tronco, sufixo diferente). Só
   *  sugere — não vincula. Exclui o próprio produto + os já vinculados. */
  async suggestForBase(orgId: string, baseProductId: string): Promise<VariantSuggestion[]> {
    const base = (await this.fetchProducts(orgId, [baseProductId])).get(baseProductId)
    if (!base) throw new BadRequestException('Produto não encontrado')
    const root = skuRoot(base.sku)
    if (!root) return []

    // Já vinculados (pra excluir das sugestões)
    const { data: existing } = await supabaseAdmin
      .from('storefront_product_variants')
      .select('variant_product_id')
      .eq('organization_id', orgId)
      .eq('base_product_id', baseProductId)
    const linked = new Set((existing ?? []).map(r => (r as { variant_product_id: string }).variant_product_id))

    // Candidatos: produtos da org com SKU não-nulo que compartilham a raiz
    const { data: cands } = await supabaseAdmin
      .from('products')
      .select(PROD_COLS)
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .not('sku', 'is', null)
      .ilike('sku', `${root}%`)
      .limit(60)

    return ((cands ?? []) as ProductRow[])
      .filter(p => p.id !== baseProductId && !linked.has(p.id) && skuRoot(p.sku) === root)
      .map(p => ({
        productId:    p.id,
        name:         p.name,
        sku:          p.sku,
        suggestLabel: skuSuffix(p.sku, root),
        imageUrl:     firstPhoto(p.photo_urls),
      }))
  }

  // ── Vitrine (público) ──────────────────────────────────────────────────────

  /** Variantes DISPONÍVEIS (visíveis + com estoque) de um produto, com preço
   *  efetivo — usado pelo provador na vitrine. */
  async publicListForBase(orgId: string, baseProductId: string): Promise<VariantView[]> {
    const all = await this.listForBase(orgId, baseProductId)
    return all.filter(v => v.available)
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async fetchProducts(orgId: string, ids: string[]): Promise<Map<string, ProductRow>> {
    const uniq = Array.from(new Set(ids.filter(Boolean)))
    if (uniq.length === 0) return new Map()
    const { data } = await supabaseAdmin
      .from('products')
      .select(PROD_COLS)
      .eq('organization_id', orgId)
      .in('id', uniq)
    return new Map(((data ?? []) as ProductRow[]).map(p => [p.id, p]))
  }

  private toView(p: ProductRow, label: string | null, nowMs: number): VariantView {
    return {
      productId: p.id,
      name:      p.name,
      sku:       p.sku,
      label:     (label ?? '').trim() || skuSuffix(p.sku, null) || null,
      imageUrl:  firstPhoto(p.photo_urls),
      price:     getEffectivePrice(p, nowMs),
      available: p.storefront_visible !== false && (p.stock ?? 0) > 0,
    }
  }
}

// ── Heurística de SKU ──────────────────────────────────────────────────────

/** Raiz do SKU = tronco sem o segmento final (que normalmente codifica a cor).
 *  Ex: "LUM-CRISTAL-DOU" -> "LUM-CRISTAL"; "ABC123DOU" -> "ABC123". */
export function skuRoot(sku: string | null): string | null {
  const s = (sku ?? '').trim().toUpperCase()
  if (!s) return null
  const parts = s.split(/[-_./\s]+/).filter(Boolean)
  if (parts.length >= 2) return parts.slice(0, -1).join('-')
  const m = s.match(/^(.*?)([A-Z]{2,})$/)
  if (m && m[1].length >= 3) return m[1]
  return null
}

/** Sufixo do SKU em relação à raiz (provável cor). */
function skuSuffix(sku: string | null, root: string | null): string | null {
  const s = (sku ?? '').trim().toUpperCase()
  if (!s) return null
  const r = root ?? skuRoot(sku)
  if (!r) return null
  const tail = s.startsWith(r) ? s.slice(r.length).replace(/^[-_./\s]+/, '') : ''
  return tail || null
}

function firstPhoto(urls: string[] | null): string | null {
  return Array.isArray(urls) && urls.length && urls[0] ? urls[0] : null
}
