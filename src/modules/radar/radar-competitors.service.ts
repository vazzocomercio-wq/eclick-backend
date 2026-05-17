import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'

/**
 * e-Click Radar IA — Concorrentes Vinculados (C3).
 *
 * A segunda metade do Radar: o vendedor vincula manualmente anúncios de
 * concorrente (não-catálogo) ao seu produto. A coleta de visitas roda no
 * eclick-workers (C2); aqui é o serviço de API — CRUD dos vínculos +
 * comparação (venda estimada via Motor 2, movimentos computados ao vivo dos
 * snapshots) + insight de IA.
 *
 * Preço do concorrente é informado pelo usuário — o ML bloqueia preço de
 * terceiro (spike C0). `price_source` nasce pronto pra extensão Chrome.
 */
@Injectable()
export class RadarCompetitorsService {
  constructor(private readonly llm: LlmService) {}

  // ── Gestão de vínculos ─────────────────────────────────────────────────────

  /** Lista produtos monitorados (com ≥1 vínculo) + contagem de concorrentes. */
  async listMonitoredProducts(orgId: string) {
    const sb = supabaseAdmin
    const { data: links, error: le } = await sb
      .from('radar_competitor_links')
      .select('product_id,status')
      .eq('organization_id', orgId)
    if (le) throw new Error(`radar_competitor_links: ${le.message}`)

    const byProduct = new Map<string, { total: number; active: number }>()
    for (const l of links ?? []) {
      const pid = l.product_id as string
      const agg = byProduct.get(pid) ?? { total: 0, active: 0 }
      agg.total++
      if (l.status === 'ativo') agg.active++
      byProduct.set(pid, agg)
    }
    const productIds = [...byProduct.keys()]
    if (productIds.length === 0) return []

    const { data: products, error: pe } = await sb
      .from('products')
      .select('id,name,sku,category_ml_id,cost_price,my_price,photo_urls')
      .eq('organization_id', orgId)
      .in('id', productIds)
    if (pe) throw new Error(`products: ${pe.message}`)

    return (products ?? []).map((p) => {
      const agg = byProduct.get(p.id as string) ?? { total: 0, active: 0 }
      return {
        product_id: p.id,
        name: p.name,
        sku: p.sku,
        image: firstPhoto(p.photo_urls),
        category_id: p.category_ml_id ?? null,
        competitor_count: agg.total,
        active_count: agg.active,
      }
    })
  }

  /** Cria um vínculo produto ↔ anúncio concorrente. */
  async createLink(
    orgId: string,
    userId: string,
    body: { product_id?: string; url?: string; item_id?: string; label?: string; current_price?: number },
  ) {
    const sb = supabaseAdmin
    if (!body.product_id) throw new BadRequestException('product_id obrigatório')

    const { data: product } = await sb
      .from('products')
      .select('id')
      .eq('id', body.product_id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!product) throw new NotFoundException('Produto não encontrado')

    const itemId = extractMlbItemId(body.item_id ?? body.url ?? '')
    if (!itemId) {
      throw new BadRequestException(
        'Não reconheci o anúncio do concorrente. Cole o link do anúncio (MLB-...) — catálogo (MLBU) não serve aqui.',
      )
    }

    const meta = await fetchShellMeta(itemId)
    const hasPrice = typeof body.current_price === 'number' && body.current_price > 0

    const { data, error } = await sb
      .from('radar_competitor_links')
      .insert({
        organization_id: orgId,
        platform: 'mercadolivre',
        product_id: body.product_id,
        competitor_item_id: itemId,
        competitor_url: `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/, 'MLB-')}`,
        competitor_title: meta.title,
        competitor_thumbnail: meta.thumbnail,
        label: body.label ?? null,
        current_price: hasPrice ? body.current_price : null,
        price_source: 'manual',
        price_updated_at: hasPrice ? new Date().toISOString() : null,
        created_by: userId,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException('Esse concorrente já está vinculado a este produto.')
      }
      throw new Error(`createLink: ${error.message}`)
    }
    return data
  }

  /** Atualiza preço / apelido / status de um vínculo. */
  async updateLink(
    orgId: string,
    linkId: string,
    body: { current_price?: number; label?: string; status?: string },
  ) {
    const sb = supabaseAdmin
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof body.current_price === 'number') {
      patch.current_price = body.current_price
      patch.price_source = 'manual'
      patch.price_updated_at = new Date().toISOString()
    }
    if (typeof body.label === 'string') patch.label = body.label
    if (body.status === 'ativo' || body.status === 'pausado') patch.status = body.status

    const { data, error } = await sb
      .from('radar_competitor_links')
      .update(patch)
      .eq('id', linkId)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(`updateLink: ${error.message}`)
    if (!data) throw new NotFoundException('Vínculo não encontrado')
    return data
  }

  /** Remove um vínculo (snapshots caem por ON DELETE CASCADE). */
  async deleteLink(orgId: string, linkId: string) {
    const sb = supabaseAdmin
    const { error } = await sb
      .from('radar_competitor_links')
      .delete()
      .eq('id', linkId)
      .eq('organization_id', orgId)
    if (error) throw new Error(`deleteLink: ${error.message}`)
    return { ok: true }
  }

  // ── Comparação ─────────────────────────────────────────────────────────────

  /** Tela de comparação: nosso anúncio vs concorrentes vinculados de um produto. */
  async getComparison(orgId: string, productId: string) {
    const sb = supabaseAdmin

    const { data: product } = await sb
      .from('products')
      .select('id,name,sku,category_ml_id,cost_price,my_price,photo_urls')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!product) throw new NotFoundException('Produto não encontrado')

    const { data: links, error: le } = await sb
      .from('radar_competitor_links')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .order('created_at', { ascending: true })
    if (le) throw new Error(`radar_competitor_links: ${le.message}`)

    const sinceDate = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)
    const { data: snaps, error: se } = await sb
      .from('radar_competitor_snapshots')
      .select('link_id,item_id,snapshot_date,price,visits')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .gte('snapshot_date', sinceDate)
      .order('snapshot_date', { ascending: true })
    if (se) throw new Error(`radar_competitor_snapshots: ${se.message}`)

    const snapsByLink = groupBy(snaps ?? [], (s) => (s.link_id as string | null) ?? '__own__')

    // Motor 2 — conversão calibrada da categoria do produto.
    const conversion = await this.resolveConversion(orgId, (product.category_ml_id as string | null) ?? null)

    // ── Lado próprio ──────────────────────────────────────────────────────────
    const ownSnaps = snapsByLink.get('__own__') ?? []
    const ourSeries = buildAggregatedSeries(ownSnaps)
    const ourItemIds = [...new Set(ownSnaps.map((s) => s.item_id as string))]
    const ourVisits30d = sumVisits(ownSnaps, 30)
    const ourMinPrice = minPrice(ourSeries)

    // vendas REAIS próprias (orders, 30d) — base honesta contra estimativa do concorrente
    let ourRealUnits30d = 0
    if (ourItemIds.length > 0) {
      const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const { data: orders } = await sb
        .from('orders')
        .select('quantity,status')
        .eq('organization_id', orgId)
        .in('marketplace_listing_id', ourItemIds)
        .gte('created_at', since30)
      for (const o of orders ?? []) {
        if ((o.status as string | null) === 'cancelled') continue
        ourRealUnits30d += Number(o.quantity) || 0
      }
    }

    // ── Lado concorrente ──────────────────────────────────────────────────────
    const competitors = (links ?? []).map((link) => {
      const ls = snapsByLink.get(link.id as string) ?? []
      const series = buildSeries(ls)
      const visits30d = sumVisits(ls, 30)
      const price = link.current_price as number | null
      const estUnits = conversion.rate != null ? Math.round(visits30d * conversion.rate) : null
      const estRevenue = estUnits != null && price != null ? Math.round(estUnits * price) : null
      const priceVsUsPct =
        price != null && ourMinPrice != null && ourMinPrice > 0
          ? Math.round(((price - ourMinPrice) / ourMinPrice) * 1000) / 10
          : null
      return {
        link_id: link.id,
        item_id: link.competitor_item_id,
        label: link.label,
        title: link.competitor_title,
        url: link.competitor_url,
        thumbnail: link.competitor_thumbnail,
        status: link.status,
        current_price: price,
        price_source: link.price_source,
        price_updated_at: link.price_updated_at,
        visits_30d: visits30d,
        est_units_30d: estUnits,
        est_revenue_30d: estRevenue,
        price_vs_us_pct: priceVsUsPct,
        series,
        movements: detectMovements(series, priceVsUsPct),
      }
    })

    return {
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        image: firstPhoto(product.photo_urls),
        category_id: product.category_ml_id ?? null,
        cost_price: product.cost_price ?? null,
        my_price: product.my_price ?? null,
      },
      conversion,
      our_side: {
        item_ids: ourItemIds,
        min_price: ourMinPrice,
        visits_30d: ourVisits30d,
        real_units_30d: ourRealUnits30d,
        series: ourSeries,
      },
      competitors,
    }
  }

  /** Insight de IA — leitura curta e acionável dos movimentos dos concorrentes. */
  async getInsight(orgId: string, productId: string): Promise<{ insight: string }> {
    const cmp = await this.getComparison(orgId, productId)
    if (cmp.competitors.length === 0) {
      return { insight: 'Nenhum concorrente vinculado ainda — adicione anúncios concorrentes para receber leituras.' }
    }

    const lines = cmp.competitors.map((c, i) => {
      const nome = c.label || c.title || `Concorrente ${i + 1}`
      const preco = c.current_price != null ? `R$ ${c.current_price}` : 'preço não informado'
      const vsNos = c.price_vs_us_pct != null
        ? (c.price_vs_us_pct < 0 ? `${Math.abs(c.price_vs_us_pct)}% MAIS BARATO que você` : `${c.price_vs_us_pct}% mais caro que você`)
        : 'sem comparação de preço'
      const mov = c.movements.map((m) => m.label).join('; ') || 'sem movimentos relevantes'
      return `- ${nome}: ${preco} (${vsNos}); visitas 30d=${c.visits_30d}, venda estimada 30d=${c.est_units_30d ?? '—'} un. Movimentos: ${mov}.`
    })

    const userPrompt =
      `Produto: ${cmp.product.name}\n` +
      `Você: preço R$ ${cmp.our_side.min_price ?? '—'}, visitas 30d=${cmp.our_side.visits_30d}, vendas reais 30d=${cmp.our_side.real_units_30d} un.\n` +
      `Concorrentes vinculados:\n${lines.join('\n')}\n\n` +
      `Escreva uma leitura curta (máx 3 frases) e acionável: o que os concorrentes estão fazendo e qual decisão considerar. Sem rodeios.`

    try {
      const out = await this.llm.generateText({
        orgId,
        feature: 'radar_competitor_insight',
        systemPrompt:
          'Você é um analista de inteligência de mercado para vendedores de marketplace brasileiros. ' +
          'Responda em PT-BR, direto, foco em decisão. Venda estimada é estimativa (visitas × conversão), não dado real do concorrente — não a trate como certeza.',
        userPrompt,
        maxTokens: 220,
      })
      return { insight: out.text.trim() }
    } catch {
      return { insight: 'Não foi possível gerar o insight agora. Os dados de comparação continuam disponíveis acima.' }
    }
  }

  // ── Motor 2 — conversão calibrada (leitura focada) ─────────────────────────

  private async resolveConversion(orgId: string, categoryId: string | null) {
    const { data } = await supabaseAdmin
      .from('radar_conversion_calibration')
      .select('calc_date,category_id,conversion_rate,confidence')
      .eq('organization_id', orgId)
      .order('calc_date', { ascending: false })
    const rows = data ?? []
    if (rows.length === 0) {
      return { rate: null as number | null, basis: 'indisponível' as const, confidence: 'low' as const, calc_date: null as string | null }
    }
    const latest = rows[0].calc_date as string
    const sameDate = rows.filter((r) => r.calc_date === latest)
    if (categoryId) {
      const cat = sameDate.find((r) => r.category_id === categoryId)
      if (cat && cat.confidence === 'ok' && cat.conversion_rate != null) {
        return { rate: Number(cat.conversion_rate), basis: 'categoria' as const, confidence: 'ok' as const, calc_date: latest }
      }
    }
    const org = sameDate.find((r) => r.category_id == null)
    if (org && org.conversion_rate != null) {
      return {
        rate: Number(org.conversion_rate),
        basis: 'organização' as const,
        confidence: (org.confidence === 'ok' ? 'ok' : 'low') as 'ok' | 'low',
        calc_date: latest,
      }
    }
    return { rate: null as number | null, basis: 'indisponível' as const, confidence: 'low' as const, calc_date: latest }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Primeira foto do produto (products.photo_urls é text[]). */
function firstPhoto(photoUrls: unknown): string | null {
  return Array.isArray(photoUrls) && photoUrls.length > 0 && typeof photoUrls[0] === 'string'
    ? photoUrls[0]
    : null
}

interface SnapRow { item_id: unknown; snapshot_date: unknown; price: unknown; visits: unknown; link_id?: unknown }
export interface SeriesPoint { date: string; price: number | null; visits: number }

/** Extrai o item_id (MLBxxxx) de uma URL ou string. Rejeita catálogo (MLBU/A/B). */
function extractMlbItemId(input: string): string | null {
  if (!input) return null
  let s = input.trim()
  try { s = decodeURIComponent(s) } catch { /* mantém original */ }

  const q = s.match(/item_id[=:]?(MLB-?\d+)/i)
  if (q) return normalizeMlb(q[1])
  const wid = s.match(/[?&]wid=(MLB-?\d+)/i)
  if (wid) return normalizeMlb(wid[1])

  const stripped = s.replace(/\/p\/MLB-?\d+/gi, '') // tira catalog product id da path
  const direct = stripped.match(/MLB-?(\d{6,})/i)
  if (direct && !/MLB[UAB]/i.test(direct[0])) return `MLB${direct[1]}`
  return null
}
function normalizeMlb(raw: string): string {
  return `MLB${raw.replace(/^MLB-?/i, '')}`
}

const SHELL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
}
/** Busca título + imagem do anúncio na casca SEO da página pública. Best-effort. */
async function fetchShellMeta(itemId: string): Promise<{ title: string | null; thumbnail: string | null }> {
  try {
    const url = `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/, 'MLB-')}`
    const res = await fetch(url, { headers: SHELL_HEADERS, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { title: null, thumbnail: null }
    const html = await res.text()
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? null
    const thumb = html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ?? null
    return { title, thumbnail: thumb }
  } catch {
    return { title: null, thumbnail: null }
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const arr = m.get(k)
    if (arr) arr.push(r)
    else m.set(k, [r])
  }
  return m
}

/** Série diária de 1 anúncio, com carry-forward do último preço conhecido. */
function buildSeries(rows: SnapRow[]): SeriesPoint[] {
  const sorted = [...rows].sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)))
  let lastPrice: number | null = null
  return sorted.map((r) => {
    const p = r.price != null ? Number(r.price) : null
    if (p != null) lastPrice = p
    return { date: String(r.snapshot_date), price: p ?? lastPrice, visits: Number(r.visits) || 0 }
  })
}

/** Série agregada do lado próprio: visitas somadas, menor preço por data. */
function buildAggregatedSeries(rows: SnapRow[]): SeriesPoint[] {
  const byDate = new Map<string, { visits: number; price: number | null }>()
  for (const r of rows) {
    const d = String(r.snapshot_date)
    const agg = byDate.get(d) ?? { visits: 0, price: null }
    agg.visits += Number(r.visits) || 0
    const p = r.price != null ? Number(r.price) : null
    if (p != null) agg.price = agg.price == null ? p : Math.min(agg.price, p)
    byDate.set(d, agg)
  }
  const dates = [...byDate.keys()].sort()
  let lastPrice: number | null = null
  return dates.map((d) => {
    const agg = byDate.get(d)!
    if (agg.price != null) lastPrice = agg.price
    return { date: d, price: agg.price ?? lastPrice, visits: agg.visits }
  })
}

function sumVisits(rows: SnapRow[], lastNDays: number): number {
  const cutoff = new Date(Date.now() - lastNDays * 86_400_000).toISOString().slice(0, 10)
  let total = 0
  for (const r of rows) {
    if (String(r.snapshot_date) >= cutoff) total += Number(r.visits) || 0
  }
  return total
}

function minPrice(series: SeriesPoint[]): number | null {
  let min: number | null = null
  for (const p of series) {
    if (p.price != null) min = min == null ? p.price : Math.min(min, p.price)
  }
  // o "preço atual" do lado próprio é o mais recente, não o mínimo histórico
  const recent = [...series].reverse().find((p) => p.price != null)
  return recent ? recent.price : min
}

export interface Movement { kind: 'preco' | 'visitas' | 'undercut'; severity: 'info' | 'atencao' | 'critico'; label: string }

/** Movimentos computados ao vivo da série — sem tabela de eventos. */
function detectMovements(series: SeriesPoint[], priceVsUsPct: number | null): Movement[] {
  const out: Movement[] = []

  // 1. mudança de preço — último ponto vs ponto mais antigo com preço diferente
  const priced = series.filter((p) => p.price != null) as Array<SeriesPoint & { price: number }>
  if (priced.length >= 2) {
    const last = priced[priced.length - 1]
    let prev: (SeriesPoint & { price: number }) | null = null
    for (let i = priced.length - 2; i >= 0; i--) {
      if (priced[i].price !== last.price) { prev = priced[i]; break }
    }
    if (prev) {
      const pct = Math.round(((last.price - prev.price) / prev.price) * 1000) / 10
      const dir = pct < 0 ? 'baixou' : 'subiu'
      out.push({
        kind: 'preco',
        severity: Math.abs(pct) >= 10 ? 'atencao' : 'info',
        label: `Preço ${dir} ${Math.abs(pct)}% (R$ ${prev.price} → R$ ${last.price})`,
      })
    }
  }

  // 2. tendência de visitas — últimos 7d vs 7d anteriores
  if (series.length >= 8) {
    const last7 = series.slice(-7).reduce((a, p) => a + p.visits, 0)
    const prev7 = series.slice(-14, -7).reduce((a, p) => a + p.visits, 0)
    if (prev7 > 0) {
      const pct = Math.round(((last7 - prev7) / prev7) * 100)
      if (Math.abs(pct) >= 25) {
        out.push({
          kind: 'visitas',
          severity: pct > 0 ? 'atencao' : 'info',
          label: `Visitas ${pct > 0 ? 'subindo' : 'caindo'} ${Math.abs(pct)}% (7d)`,
        })
      }
    }
  }

  // 3. undercut — concorrente mais barato que você
  if (priceVsUsPct != null && priceVsUsPct < 0) {
    out.push({
      kind: 'undercut',
      severity: priceVsUsPct <= -10 ? 'critico' : 'atencao',
      label: `${Math.abs(priceVsUsPct)}% mais barato que você`,
    })
  }

  return out
}
