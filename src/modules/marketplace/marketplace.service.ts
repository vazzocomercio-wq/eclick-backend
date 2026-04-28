import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MarketplaceAdapterRegistry } from './adapters/registry'
import { MarketplacePlatform, MpConnection } from './adapters/base'
import { encryptConfig, decryptConfig } from './crypto.util'

/** Service de leitura/escrita de marketplace_connections. Decifra config_encrypted
 * antes de devolver pros adapters; encripta antes de gravar. Adapters vivem em
 * registry e são pegos por platform. */
@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name)

  constructor(private readonly registry: MarketplaceAdapterRegistry) {}

  /** Lista todas as connections de uma org, com config decifrado pronto pra
   * usar. Falha de decrypt em uma row não derruba todas — log warn e retorna
   * essa row com config=null. */
  async listConnections(orgId: string): Promise<MpConnection[]> {
    const { data, error } = await supabaseAdmin
      .from('marketplace_connections')
      .select('*')
      .eq('organization_id', orgId)
      .eq('status', 'connected')
      .order('platform', { ascending: true })
    if (error) throw new Error(error.message)
    return (data ?? []).map(row => this.hydrate(row as DbRow))
  }

  /** Pega 1 connection específica. */
  async getConnection(orgId: string, platform: MarketplacePlatform): Promise<MpConnection | null> {
    const { data } = await supabaseAdmin
      .from('marketplace_connections')
      .select('*')
      .eq('organization_id', orgId)
      .eq('platform', platform)
      .eq('status', 'connected')
      .maybeSingle()
    if (!data) return null
    return this.hydrate(data as DbRow)
  }

  /** Cria/atualiza connection. config plain → encripta antes de gravar. */
  async upsertConnection(input: Omit<MpConnection, 'id'> & { id?: string }): Promise<MpConnection> {
    const config_encrypted = input.config ? encryptConfig(input.config as Record<string, unknown>) : null
    const row: Partial<DbRow> = {
      organization_id:  input.organization_id,
      platform:         input.platform,
      seller_id:        input.seller_id      ?? null,
      shop_id:          input.shop_id        ?? null,
      partner_id:       input.partner_id     ?? null,
      marketplace_id:   input.marketplace_id ?? null,
      external_id:      input.external_id    ?? null,
      access_token:     input.access_token   ?? null,
      refresh_token:    input.refresh_token  ?? null,
      expires_at:       input.expires_at     ?? null,
      config_encrypted: config_encrypted     ?? null,
      nickname:         input.nickname       ?? null,
      status:           input.status         ?? 'connected',
      updated_at:       new Date().toISOString(),
    }
    if (input.id) {
      const { data, error } = await supabaseAdmin
        .from('marketplace_connections').update(row).eq('id', input.id)
        .select().single()
      if (error) throw new Error(error.message)
      return this.hydrate(data as DbRow)
    }
    const { data, error } = await supabaseAdmin
      .from('marketplace_connections').insert(row).select().single()
    if (error) throw new Error(error.message)
    return this.hydrate(data as DbRow)
  }

  /** Atualiza tokens depois de refresh — não toca em config. */
  async updateTokens(connectionId: string, tokens: { access_token: string; refresh_token: string; expires_at: string }): Promise<void> {
    const { error } = await supabaseAdmin
      .from('marketplace_connections')
      .update({ ...tokens, updated_at: new Date().toISOString() })
      .eq('id', connectionId)
    if (error) this.logger.error(`[mp.updateTokens] ${error.message}`)
  }

  /** Marca como disconnected — útil quando refresh falha 4xx. Não deleta a
   * row pra preservar config_encrypted (user reconecta sem reentrar secrets). */
  async markDisconnected(connectionId: string, reason?: string): Promise<void> {
    await supabaseAdmin
      .from('marketplace_connections')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('id', connectionId)
    this.logger.warn(`[mp.disconnected] connection=${connectionId} reason=${reason ?? '?'}`)
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private hydrate(row: DbRow): MpConnection {
    let config: Record<string, unknown> | null = null
    try {
      config = decryptConfig(row.config_encrypted)
    } catch (e: unknown) {
      this.logger.warn(`[mp.decrypt] connection=${row.id} ${(e as Error)?.message}`)
    }
    return {
      id:              row.id,
      organization_id: row.organization_id,
      platform:        row.platform as MarketplacePlatform,
      seller_id:       row.seller_id      ?? null,
      shop_id:         row.shop_id        ?? null,
      partner_id:      row.partner_id     ?? null,
      marketplace_id:  row.marketplace_id ?? null,
      external_id:     row.external_id    ?? null,
      access_token:    row.access_token   ?? null,
      refresh_token:   row.refresh_token  ?? null,
      expires_at:      row.expires_at     ?? null,
      config,
      nickname:        row.nickname       ?? null,
      status:          row.status         ?? null,
    }
  }

  /** Atalho: pega connection + adapter prontos pra uso. */
  async resolve(orgId: string, platform: MarketplacePlatform) {
    const conn = await this.getConnection(orgId, platform)
    if (!conn) return null
    return { conn, adapter: this.registry.get(platform) }
  }
}

interface DbRow {
  id: string; organization_id: string; platform: string
  seller_id?: number | null; shop_id?: number | null; partner_id?: number | null
  marketplace_id?: string | null; external_id?: string | null
  access_token?: string | null; refresh_token?: string | null; expires_at?: string | null
  config_encrypted?: string | null; nickname?: string | null; status?: string | null
  updated_at?: string | null
}
