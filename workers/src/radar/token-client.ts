import type { OrgTokenData } from './types.js'

/**
 * Busca token ML + sellers próprios de uma org via endpoint interno da API
 * (`GET /internal/ml/token`). O token fica fonte única na API — o worker
 * não reimplementa OAuth nem precisa do ML_CLIENT_SECRET.
 *
 * Config necessária no env do eclick-workers:
 *   INTERNAL_API_URL  — ex: http://eclick-backend.railway.internal:3001
 *   INTERNAL_API_KEY  — mesma chave do internal-server reverso (Baileys)
 */
export async function fetchOrgToken(orgId: string): Promise<OrgTokenData> {
  const baseUrl = process.env.INTERNAL_API_URL
  const key = process.env.INTERNAL_API_KEY
  if (!baseUrl) {
    throw new Error(
      'INTERNAL_API_URL ausente — setar no env do eclick-workers ' +
      '(ex: http://eclick-backend.railway.internal:3001)',
    )
  }
  if (!key) {
    throw new Error('INTERNAL_API_KEY ausente no env do eclick-workers')
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/internal/ml/token?org_id=${encodeURIComponent(orgId)}`
  const res = await fetch(url, { headers: { 'X-Internal-Key': key } })
  if (!res.ok) {
    throw new Error(`fetchOrgToken org=${orgId} falhou: HTTP ${res.status}`)
  }
  const body = (await res.json()) as { token: string; own_seller_ids: number[] }
  return { token: body.token, ownSellerIds: body.own_seller_ids ?? [] }
}

/**
 * Token de uma org com refresh sob demanda. O ml-api chama `refresh()` ao
 * receber 401 — cobre o caso de uma rodada longa ultrapassar a validade.
 */
export class OrgToken {
  token: string
  readonly ownSellerIds: number[]

  constructor(private readonly orgId: string, data: OrgTokenData) {
    this.token = data.token
    this.ownSellerIds = data.ownSellerIds
  }

  async refresh(): Promise<void> {
    const data = await fetchOrgToken(this.orgId)
    this.token = data.token
  }

  /** true se o seller pertence à org (flag is_own). */
  isOwnSeller(sellerId: number): boolean {
    return this.ownSellerIds.includes(sellerId)
  }
}

export async function loadOrgToken(orgId: string): Promise<OrgToken> {
  return new OrgToken(orgId, await fetchOrgToken(orgId))
}
