import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

/**
 * Redes/superfícies que o Analytics Hub consegue medir. Multi-rede por design.
 * - mercadolivre: marketplace (visitas/vendas/ADS ML) — multi-conta (N sellers)
 * - instagram / facebook: orgânico (reach/likes/alcance/demografia)
 * - whatsapp: catálogo + mensageria
 * - tiktok: orgânico (quando a whitelist liberar; token vive no Active)
 * - store: vitrine própria (storefront_events)
 * - meta_ads / google_ads: pago (campanhas; hoje vivem no Active)
 * - ai_engine: GEO / visibilidade nos motores de IA (ChatGPT/Perplexity/Gemini)
 */
export type AnalyticsNetwork =
  | 'mercadolivre'
  | 'instagram'
  | 'facebook'
  | 'whatsapp'
  | 'tiktok'
  | 'store'
  | 'meta_ads'
  | 'google_ads'
  | 'ai_engine'

export type AccountStatus = 'connected' | 'expired' | 'disconnected'

/** Identidade conectada normalizada — o backbone que os coletores iteram.
 *  Uma org pode ter N contas por rede (ex: Vazzo tem 2 sellers ML). */
export interface AnalyticsAccount {
  network: AnalyticsNetwork
  external_account_id: string
  label: string
  username: string | null
  status: AccountStatus
  /** o que dá pra medir/coletar nessa conexão */
  capabilities: string[]
  /** tabela de origem (de onde veio o token/identidade) */
  source: string
  token_expires_at: string | null
  metadata: Record<string, unknown>
}

interface MlConnectionRow {
  seller_id: number
  nickname: string | null
  expires_at: string | null
}

interface SocialChannelRow {
  channel: string
  status: string | null
  external_account_id: string | null
  token_expires_at: string | null
  config: Record<string, unknown> | null
}

@Injectable()
export class AnalyticsAccountsService {
  private readonly logger = new Logger(AnalyticsAccountsService.name)

  /**
   * Lista TODAS as identidades conectadas da org, normalizadas por rede.
   * Lê fontes locais do SaaS (ml_connections + social_commerce_channels).
   * Redes que vivem no Active (TikTok orgânico, contas de anúncio Meta/Google)
   * entram via bridge numa fase posterior (F4) — por isso ficam de fora aqui.
   *
   * @param network filtro opcional por rede
   */
  async listAccounts(orgId: string, network?: AnalyticsNetwork): Promise<AnalyticsAccount[]> {
    const [ml, social] = await Promise.all([
      this.mlAccounts(orgId),
      this.metaAccounts(orgId),
    ])
    const all = [...ml, ...social]
    return network ? all.filter((a) => a.network === network) : all
  }

  // ── Mercado Livre (multi-conta) ───────────────────────────────────────────

  private async mlAccounts(orgId: string): Promise<AnalyticsAccount[]> {
    const { data, error } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, nickname, expires_at')
      .eq('organization_id', orgId)
    if (error) {
      this.logger.warn(`[accounts] ml_connections falhou: ${error.message}`)
      return []
    }
    const rows = (data ?? []) as MlConnectionRow[]
    return rows.map((r) => ({
      network: 'mercadolivre' as const,
      external_account_id: String(r.seller_id),
      label: r.nickname ?? `Seller ${r.seller_id}`,
      username: r.nickname,
      // ML faz refresh automático via getTokenForOrg → existir a linha já basta.
      status: 'connected' as const,
      capabilities: ['marketplace_metrics', 'listings', 'ml_ads'],
      source: 'ml_connections',
      token_expires_at: r.expires_at,
      metadata: { seller_id: r.seller_id },
    }))
  }

  // ── Meta (Instagram + Facebook + WhatsApp) ────────────────────────────────

  private async metaAccounts(orgId: string): Promise<AnalyticsAccount[]> {
    const { data, error } = await supabaseAdmin
      .from('social_commerce_channels')
      .select('channel, status, external_account_id, token_expires_at, config')
      .eq('organization_id', orgId)
    if (error) {
      this.logger.warn(`[accounts] social_commerce_channels falhou: ${error.message}`)
      return []
    }
    const rows = (data ?? []) as SocialChannelRow[]
    const out: AnalyticsAccount[] = []

    for (const r of rows) {
      const cfg = r.config ?? {}
      const baseStatus = this.mapStatus(r.status, r.token_expires_at)

      if (r.channel === 'instagram_shop') {
        const igId = (cfg.instagram_account_id as string | undefined) ?? null
        const username = (cfg.instagram_username as string | undefined) ?? null
        if (igId) {
          out.push({
            network: 'instagram',
            external_account_id: igId,
            label: username ? `@${username}` : 'Instagram',
            username,
            status: baseStatus,
            capabilities: ['organic_insights', 'media', 'tagging', 'publish'],
            source: 'social_commerce_channels',
            token_expires_at: r.token_expires_at,
            metadata: { catalog_id: cfg.catalog_id ?? null },
          })
        }
        // A Página do Facebook vinculada vem no mesmo canal (page_id).
        const pageId = (cfg.page_id as string | undefined) ?? r.external_account_id ?? null
        if (pageId) {
          out.push({
            network: 'facebook',
            external_account_id: pageId,
            label: 'Página Facebook',
            username: null,
            status: baseStatus,
            capabilities: ['page_insights', 'publish'],
            source: 'social_commerce_channels',
            token_expires_at: r.token_expires_at,
            metadata: {},
          })
        }
      } else if (r.channel === 'whatsapp_business') {
        const wabaId = (cfg.waba_id as string | undefined) ?? r.external_account_id ?? ''
        out.push({
          network: 'whatsapp',
          external_account_id: wabaId,
          label: (cfg.display_phone as string | undefined) ?? 'WhatsApp Business',
          username: null,
          status: baseStatus,
          capabilities: ['catalog', 'messaging'],
          source: 'social_commerce_channels',
          token_expires_at: r.token_expires_at,
          metadata: { phone_number_id: cfg.phone_number_id ?? null },
        })
      }
    }
    return out
  }

  /** Deriva o status efetivo: respeita o status do canal mas rebaixa pra
   *  'expired' se o token já venceu. */
  private mapStatus(status: string | null, expiresAt: string | null): AccountStatus {
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return 'expired'
    if (status === 'connected') return 'connected'
    if (!status || status === 'disconnected') return 'disconnected'
    return 'connected'
  }
}
