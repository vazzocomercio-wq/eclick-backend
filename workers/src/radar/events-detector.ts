import { getSupabase } from '../supabase.js'
import { radarLog, errMsg } from './util.js'

// "Configurável" do R3 — constantes (versão leve; tabela de config por-org só
// quando houver orgs pedindo sensibilidades diferentes, não antes).
const PRICE_CHANGE_THRESHOLD = 0.10   // |Δ preço| >= 10% numa oferta → queda/alta_preco
const AGGRESSIVE_UNDERCUT_PCT = 0.10  // novo menor preço >= 10% abaixo da Vazzo → critico
const PRIOR_WINDOW_DAYS = 7           // janela pra achar a rodada anterior de cada produto

export interface EventsResult {
  catalog_products: number
  baselined: number // produtos em 1ª aparição (baseline silencioso, 0 evento)
  events_created: number
  errors: number
}

interface Snap {
  catalog_product_ref: string
  item_id: string
  seller_ref: string | null
  price: number | null
  free_shipping: boolean | null
  logistic_type: string | null
  collected_at: string
}

interface EventRow {
  catalog_product_ref: string
  seller_ref: string | null
  item_id: string | null
  event_type: string
  previous_value: unknown
  new_value: unknown
  severity: string
}

/**
 * Motor de eventos do e-Click Radar IA (R3). Roda como passo final do runDaily()
 * — depois de offers/visits/sellers. Compara os snapshots de HOJE com a rodada
 * ANTERIOR de cada produto de catálogo (por produto, não data global da org) e
 * gera radar_events. Regra simples, sem IA.
 *
 * - Baseline de 1ª aparição: produto sem rodada anterior → baseline silencioso,
 *   zero evento (cobre a 1ª rodada e cada produto novo da descoberta semanal).
 * - Idempotente: Set de dedup carregado dos radar_events já criados hoje.
 */
export async function detectEvents(orgId: string): Promise<EventsResult> {
  const sb = getSupabase()
  const r: EventsResult = { catalog_products: 0, baselined: 0, events_created: 0, errors: 0 }

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()
  const windowIso = new Date(todayStart.getTime() - PRIOR_WINDOW_DAYS * 86_400_000).toISOString()
  const cols = 'catalog_product_ref,item_id,seller_ref,price,free_shipping,logistic_type,collected_at'

  const { data: todayRows, error: e1 } = await sb
    .from('radar_offer_snapshots')
    .select(cols)
    .eq('organization_id', orgId)
    .gte('collected_at', todayIso)
  if (e1) throw new Error(`today snapshots: ${e1.message}`)

  const { data: priorRows, error: e2 } = await sb
    .from('radar_offer_snapshots')
    .select(cols)
    .eq('organization_id', orgId)
    .gte('collected_at', windowIso)
    .lt('collected_at', todayIso)
  if (e2) throw new Error(`prior snapshots: ${e2.message}`)

  // is_own por item — vem de radar_offers (estado atual)
  const { data: offerRows, error: e3 } = await sb
    .from('radar_offers')
    .select('item_id,is_own')
    .eq('organization_id', orgId)
  if (e3) throw new Error(`offers: ${e3.message}`)
  const isOwnByItem = new Map<string, boolean>()
  for (const o of offerRows ?? []) isOwnByItem.set(o.item_id as string, o.is_own === true)

  // dedup — eventos já criados hoje
  const { data: evRows, error: e4 } = await sb
    .from('radar_events')
    .select('catalog_product_ref,item_id,event_type')
    .eq('organization_id', orgId)
    .gte('detected_at', todayIso)
  if (e4) throw new Error(`existing events: ${e4.message}`)
  const seen = new Set<string>()
  for (const ev of evRows ?? []) {
    seen.add(`${ev.catalog_product_ref}|${ev.item_id ?? ''}|${ev.event_type}`)
  }

  const todayByCp = groupByCp((todayRows ?? []) as Snap[])
  const priorByCp = groupByCp((priorRows ?? []) as Snap[])

  const pending: Array<EventRow & { organization_id: string }> = []
  for (const [cpRef, today] of todayByCp) {
    r.catalog_products++
    try {
      const priorAll = priorByCp.get(cpRef) ?? []
      if (priorAll.length === 0) {
        r.baselined++ // 1ª aparição — baseline silencioso
        continue
      }
      // só a rodada anterior mais recente DESTE produto
      const prevDate = priorAll.map((s) => s.collected_at.slice(0, 10)).sort().at(-1)!
      const prev = priorAll.filter((s) => s.collected_at.slice(0, 10) === prevDate)

      for (const evt of diffCatalogProduct(cpRef, today, prev, isOwnByItem)) {
        const key = `${evt.catalog_product_ref}|${evt.item_id ?? ''}|${evt.event_type}`
        if (seen.has(key)) continue
        seen.add(key)
        pending.push({ ...evt, organization_id: orgId })
      }
    } catch (e) {
      r.errors++
      radarLog('events', 'catálogo falhou', cpRef, errMsg(e))
    }
  }

  for (let i = 0; i < pending.length; i += 200) {
    const chunk = pending.slice(i, i + 200)
    const { error } = await sb.from('radar_events').insert(chunk)
    if (error) {
      r.errors++
      radarLog('events', 'insert falhou', error.message)
    } else {
      r.events_created += chunk.length
    }
  }
  return r
}

function groupByCp(rows: Snap[]): Map<string, Snap[]> {
  const m = new Map<string, Snap[]>()
  for (const row of rows) {
    const arr = m.get(row.catalog_product_ref)
    if (arr) arr.push(row)
    else m.set(row.catalog_product_ref, [row])
  }
  return m
}

function minPrice(rows: Snap[]): number | null {
  let min: number | null = null
  for (const s of rows) {
    if (s.price != null && (min === null || s.price < min)) min = s.price
  }
  return min
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

function ev(
  cpRef: string,
  itemId: string | null,
  sellerRef: string | null,
  type: string,
  prev: unknown,
  next: unknown,
  severity: string,
): EventRow {
  return {
    catalog_product_ref: cpRef,
    item_id: itemId,
    seller_ref: sellerRef,
    event_type: type,
    previous_value: prev,
    new_value: next,
    severity,
  }
}

/** Diff de um produto de catálogo: hoje vs a rodada anterior. */
function diffCatalogProduct(
  cpRef: string,
  today: Snap[],
  prev: Snap[],
  isOwnByItem: Map<string, boolean>,
): EventRow[] {
  const events: EventRow[] = []
  const prevByItem = new Map(prev.map((s): [string, Snap] => [s.item_id, s]))
  const todayByItem = new Map(today.map((s): [string, Snap] => [s.item_id, s]))

  for (const [itemId, t] of todayByItem) {
    const p = prevByItem.get(itemId)
    if (!p) {
      events.push(ev(cpRef, itemId, t.seller_ref, 'novo_concorrente',
        null, { price: t.price, seller_ref: t.seller_ref }, 'info'))
      continue
    }
    // preço — concorrente que mexe ±10% é atencao; oferta própria é info
    if (p.price != null && t.price != null && p.price > 0) {
      const pct = (t.price - p.price) / p.price
      if (Math.abs(pct) >= PRICE_CHANGE_THRESHOLD) {
        const isOwn = isOwnByItem.get(itemId) === true
        events.push(ev(cpRef, itemId, t.seller_ref, pct < 0 ? 'queda_preco' : 'alta_preco',
          { price: p.price }, { price: t.price, pct_change: round4(pct) },
          isOwn ? 'info' : 'atencao'))
      }
    }
    // frete
    if (p.free_shipping !== t.free_shipping || p.logistic_type !== t.logistic_type) {
      events.push(ev(cpRef, itemId, t.seller_ref, 'mudanca_frete',
        { free_shipping: p.free_shipping, logistic_type: p.logistic_type },
        { free_shipping: t.free_shipping, logistic_type: t.logistic_type }, 'info'))
    }
  }

  for (const [itemId, p] of prevByItem) {
    if (!todayByItem.has(itemId)) {
      events.push(ev(cpRef, itemId, p.seller_ref, 'saiu_concorrente',
        { price: p.price, seller_ref: p.seller_ref }, null, 'info'))
    }
  }

  const lead = detectLeadChange(cpRef, today, prev, isOwnByItem)
  if (lead) events.push(lead)
  return events
}

/**
 * mudanca_menor_preco — detecta flip da liderança de preço da Vazzo.
 * Severidade: Vazzo perde a ponta → atencao; critico só se o undercut for
 * agressivo (>= AGGRESSIVE_UNDERCUT_PCT — sinal de guerra de preço). Vazzo
 * ganha a ponta → info. Empate de menor preço resolvido por item_id (sort).
 */
function detectLeadChange(
  cpRef: string,
  today: Snap[],
  prev: Snap[],
  isOwnByItem: Map<string, boolean>,
): EventRow | null {
  const todayMin = minPrice(today)
  const prevMin = minPrice(prev)
  if (todayMin === null || prevMin === null) return null

  const todayVazzo = today.filter((s) => isOwnByItem.get(s.item_id) === true && s.price != null)
  const prevVazzo = prev.filter((s) => isOwnByItem.get(s.item_id) === true && s.price != null)
  if (todayVazzo.length === 0 || prevVazzo.length === 0) return null // Vazzo sem oferta — skip

  const todayVazzoPrice = Math.min(...todayVazzo.map((s) => s.price as number))
  const prevVazzoPrice = Math.min(...prevVazzo.map((s) => s.price as number))
  const prevHadLead = prevVazzoPrice === prevMin
  const todayHasLead = todayVazzoPrice === todayMin
  if (prevHadLead === todayHasLead) return null // sem flip → sem evento

  // item de menor preço de hoje — determinístico (empate resolvido por item_id)
  const lowestItem = today.filter((s) => s.price === todayMin)
    .map((s) => s.item_id).sort()[0] ?? null

  if (prevHadLead && !todayHasLead) {
    // Vazzo perdeu a ponta — critico só se o undercut for agressivo
    const undercut = todayVazzoPrice > 0 ? (todayVazzoPrice - todayMin) / todayVazzoPrice : 0
    return ev(cpRef, lowestItem, null, 'mudanca_menor_preco',
      { leader: 'vazzo', vazzo_price: prevVazzoPrice, min_price: prevMin },
      {
        leader: 'concorrente', lowest_item: lowestItem, min_price: todayMin,
        vazzo_price: todayVazzoPrice, undercut_pct: round4(undercut),
      },
      undercut >= AGGRESSIVE_UNDERCUT_PCT ? 'critico' : 'atencao')
  }
  // Vazzo ganhou a ponta — notícia boa, baixa urgência
  return ev(cpRef, lowestItem, null, 'mudanca_menor_preco',
    { leader: 'concorrente', min_price: prevMin },
    { leader: 'vazzo', lowest_item: lowestItem, min_price: todayMin }, 'info')
}
