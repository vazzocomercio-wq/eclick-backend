import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { MarketplaceAdapterRegistry } from '../adapters/registry'
import { MpConnection } from '../adapters/base'

/** F18 F0.2 — Refresh proativo de tokens Shopee.
 *
 *  Roda de hora em hora e renova os tokens que vencem na próxima 1h. O
 *  access_token Shopee dura ~4h e o refresh_token ~30 dias e ROTACIONA a cada
 *  refresh — por isso persistimos os 2 tokens novos (updateTokens). Se o
 *  refresh falhar por error_auth (refresh_token expirado/30d), marca a conexão
 *  como disconnected pra o lojista re-autorizar (não deleta — preserva config).
 *
 *  Complementa o refresh-on-demand do ShopeeProductSyncService (que renova na
 *  hora se um sync pega o token vencido). Aqui é a rede de segurança que mantém
 *  o token sempre quente mesmo sem nenhum sync acontecer. */
@Injectable()
export class ShopeeTokenRefreshWorker {
  private readonly logger = new Logger(ShopeeTokenRefreshWorker.name)
  /** Renova tokens que vencem dentro desta janela à frente. */
  private static readonly REFRESH_AHEAD_MS = 60 * 60 * 1000 // 1h

  constructor(
    private readonly mp:       MarketplaceService,
    private readonly registry: MarketplaceAdapterRegistry,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async refreshExpiring(): Promise<void> {
    const threshold = new Date(Date.now() + ShopeeTokenRefreshWorker.REFRESH_AHEAD_MS).toISOString()
    const { data, error } = await supabaseAdmin
      .from('marketplace_connections')
      .select('id, organization_id, shop_id, refresh_token, expires_at')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
      .not('refresh_token', 'is', null)
      .lt('expires_at', threshold)
    if (error) {
      this.logger.error(`[shopee.refresh] query falhou: ${error.message}`)
      return
    }
    const rows = data ?? []
    if (!rows.length) return

    const adapter = this.registry.get('shopee')
    let renewed = 0
    let failed  = 0

    for (const row of rows as RefreshRow[]) {
      const conn = {
        id:              row.id,
        organization_id: row.organization_id,
        platform:        'shopee',
        shop_id:         row.shop_id,
        access_token:    null,
        refresh_token:   row.refresh_token,
        expires_at:      row.expires_at,
      } as MpConnection
      try {
        const tokens = await adapter.refreshToken(conn)
        await this.mp.updateTokens(conn.id, tokens)
        renewed++
      } catch (e: unknown) {
        failed++
        const msg = (e as Error)?.message ?? ''
        this.logger.warn(`[shopee.refresh] conn=${conn.id} falhou: ${msg}`)
        // refresh_token expirado (30d) ou inválido → re-OAuth necessário.
        if (/error_auth|invalid|expired/i.test(msg)) {
          await this.mp.markDisconnected(conn.id, 'refresh_token inválido/expirado — re-autorizar')
        }
      }
    }

    if (renewed || failed) {
      this.logger.log(`[shopee.refresh] renovados=${renewed} falhas=${failed} (de ${rows.length})`)
    }
  }
}

interface RefreshRow {
  id:              string
  organization_id: string
  shop_id:         number | null
  refresh_token:   string | null
  expires_at:      string | null
}
