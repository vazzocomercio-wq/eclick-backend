import { getSupabase } from '../../supabase.js'
import type { OrgToken } from '../token-client.js'
import { getUser, sleep } from '../ml-api.js'
import { radarLog, errMsg } from '../util.js'

export interface SellersResult {
  refreshed: number
  errors: number
}

const STALE_DAYS = 7

interface MlUserShape {
  nickname?: string
  seller_reputation?: {
    level_id?: string
    power_seller_status?: string | null
    transactions?: { total?: number }
    metrics?: unknown
  }
}

/**
 * Coletor de sellers — enriquece radar_sellers via /users/{id}. Refresh lento:
 * só sellers nunca enriquecidos ou sem refresh há mais de 7 dias (a reputação
 * muda devagar; rodar isso todo dia seria desperdício de chamada).
 */
export async function collectSellers(orgId: string, tok: OrgToken): Promise<SellersResult> {
  const sb = getSupabase()
  const r: SellersResult = { refreshed: 0, errors: 0 }
  const staleBefore = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString()

  const { data: sellers, error } = await sb
    .from('radar_sellers')
    .select('id, seller_id, updated_at, nickname')
    .eq('organization_id', orgId)
  if (error) throw new Error(`radar_sellers read: ${error.message}`)

  const due = (sellers ?? []).filter(
    (s) => !s.nickname || (s.updated_at as string) < staleBefore,
  )

  for (const s of due) {
    try {
      const user = (await getUser(s.seller_id as number, tok)) as MlUserShape
      const rep = user.seller_reputation ?? {}
      const now = new Date().toISOString()
      const { error: upErr } = await sb
        .from('radar_sellers')
        .update({
          nickname: user.nickname ?? null,
          reputation_level: rep.level_id ?? null,
          power_seller_status: rep.power_seller_status ?? null,
          transactions_total: rep.transactions?.total ?? null,
          metrics: rep.metrics ?? null,
          last_seen_at: now,
          updated_at: now,
        })
        .eq('id', s.id)
      if (upErr) {
        r.errors++
        radarLog('sellers', 'update falhou', s.seller_id, upErr.message)
      } else {
        r.refreshed++
      }
      await sleep(150)
    } catch (e) {
      r.errors++
      radarLog('sellers', 'seller falhou', s.seller_id, errMsg(e))
    }
  }
  return r
}
