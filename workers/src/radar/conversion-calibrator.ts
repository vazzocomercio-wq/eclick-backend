import { getSupabase } from '../supabase.js'
import { radarLog } from './util.js'

/**
 * Motor 2 (MVP 2) — calibrador da conversão.
 *
 * Passo do runDaily() no worker. Mede a conversão REAL da Vazzo nos itens
 * próprios monitorados — unidades vendidas (tabela `orders`) ÷ visitas
 * (`radar_visit_snapshots`), janela de 30d — por categoria + uma taxa
 * org-wide. A estimativa de demanda de concorrente (M2.2) aplica essa taxa
 * sobre as visitas dele.
 */

const WINDOW_DAYS = 30
const MIN_VISITS = 200 // visitas mínimas (30d) p/ a categoria ter confidence='ok'
const MIN_UNITS = 5    // unidades mínimas (30d) idem

export interface CalibrationResult {
  categories: number
  org_visits: number
  org_units: number
  org_conversion: number | null
  errors: number
}

interface Bucket {
  items: Set<string>
  visits: number
  units: number
}

export async function calibrateConversion(orgId: string): Promise<CalibrationResult> {
  const sb = getSupabase()
  const r: CalibrationResult = { categories: 0, org_visits: 0, org_units: 0, org_conversion: null, errors: 0 }

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
  const sinceIso = since.toISOString()
  const sinceDate = sinceIso.slice(0, 10)

  // 1. produtos de catálogo → categoria
  const { data: products, error: pe } = await sb
    .from('radar_catalog_products')
    .select('id,category_id')
    .eq('organization_id', orgId)
  if (pe) throw new Error(`radar_catalog_products: ${pe.message}`)
  const categoryByCp = new Map<string, string | null>()
  for (const p of products ?? []) {
    categoryByCp.set(p.id as string, (p.category_id as string | null) ?? null)
  }

  // 2. ofertas próprias → item_id + categoria
  const { data: ownOffers, error: oe } = await sb
    .from('radar_offers')
    .select('item_id,catalog_product_ref')
    .eq('organization_id', orgId)
    .eq('is_own', true)
  if (oe) throw new Error(`radar_offers: ${oe.message}`)
  const categoryByItem = new Map<string, string | null>()
  for (const o of ownOffers ?? []) {
    categoryByItem.set(o.item_id as string, categoryByCp.get(o.catalog_product_ref as string) ?? null)
  }
  const ownItemIds = [...categoryByItem.keys()]
  if (ownItemIds.length === 0) {
    radarLog('calibrate', `org=${orgId} sem itens próprios monitorados — pula`)
    return r
  }

  // 3. visitas próprias (30d)
  const { data: visitRows, error: ve } = await sb
    .from('radar_visit_snapshots')
    .select('item_id,visits')
    .eq('organization_id', orgId)
    .in('item_id', ownItemIds)
    .gte('visit_date', sinceDate)
  if (ve) throw new Error(`radar_visit_snapshots: ${ve.message}`)
  const visitsByItem = new Map<string, number>()
  for (const v of visitRows ?? []) {
    const k = v.item_id as string
    visitsByItem.set(k, (visitsByItem.get(k) ?? 0) + (Number(v.visits) || 0))
  }

  // 4. unidades vendidas próprias (30d) — tabela orders, exclui cancelados
  const { data: orders, error: ordE } = await sb
    .from('orders')
    .select('marketplace_listing_id,quantity,status')
    .eq('organization_id', orgId)
    .in('marketplace_listing_id', ownItemIds)
    .gte('created_at', sinceIso)
  if (ordE) throw new Error(`orders: ${ordE.message}`)
  const unitsByItem = new Map<string, number>()
  for (const ord of orders ?? []) {
    if ((ord.status as string | null) === 'cancelled') continue
    const k = ord.marketplace_listing_id as string
    unitsByItem.set(k, (unitsByItem.get(k) ?? 0) + (Number(ord.quantity) || 0))
  }

  // 5. agrega por categoria + org-wide
  const byCat = new Map<string | null, Bucket>()
  const org: Bucket = { items: new Set(), visits: 0, units: 0 }
  for (const itemId of ownItemIds) {
    const cat = categoryByItem.get(itemId) ?? null
    let b = byCat.get(cat)
    if (!b) { b = { items: new Set(), visits: 0, units: 0 }; byCat.set(cat, b) }
    const v = visitsByItem.get(itemId) ?? 0
    const u = unitsByItem.get(itemId) ?? 0
    b.items.add(itemId); b.visits += v; b.units += u
    org.items.add(itemId); org.visits += v; org.units += u
  }

  // 6. monta as linhas (por categoria conhecida + org-wide com category_id NULL)
  const calcDate = new Date().toISOString().slice(0, 10)
  const mkRow = (categoryId: string | null, b: Bucket) => {
    const conversion = b.visits > 0 ? b.units / b.visits : null
    const confident = b.visits >= MIN_VISITS && b.units >= MIN_UNITS
    return {
      organization_id: orgId,
      calc_date: calcDate,
      category_id: categoryId,
      window_days: WINDOW_DAYS,
      own_items: b.items.size,
      own_visits: b.visits,
      own_units: b.units,
      conversion_rate: conversion,
      confidence: confident ? 'ok' : 'low',
    }
  }

  const rows: Array<ReturnType<typeof mkRow>> = []
  for (const [cat, b] of byCat) {
    if (cat == null) continue // categoria desconhecida contribui só pro org-wide
    rows.push(mkRow(cat, b))
    r.categories++
  }
  rows.push(mkRow(null, org)) // taxa org-wide (fallback)

  r.org_visits = org.visits
  r.org_units = org.units
  r.org_conversion = org.visits > 0 ? org.units / org.visits : null

  const { error: upErr } = await sb
    .from('radar_conversion_calibration')
    .upsert(rows, { onConflict: 'organization_id,calc_date,category_id' })
  if (upErr) {
    r.errors++
    radarLog('calibrate', 'upsert falhou', upErr.message)
  }

  return r
}
