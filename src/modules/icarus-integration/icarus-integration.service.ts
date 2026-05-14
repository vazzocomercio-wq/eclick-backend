import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { encryptConfig, decryptConfig } from '../marketplace/crypto.util'
import { IcarusApiClient, type IcarusClientConfig } from './icarus-api.client'

/**
 * Sessão 2026-05-14 — Gerencia conexões Icarus por supplier_id.
 *
 * Persistência:
 *   - access_token sempre encriptado AES-256-GCM (crypto.util.ts)
 *   - 1 conexão ativa por (supplier_id, type='icarus') — unique partial idx
 *   - config jsonb pra overrides (base_url custom, rate_limit, etc.)
 *
 * Fluxo de uso:
 *   1. Lojista vai em /dropship/fornecedores/[id] → clica "Conectar Icarus"
 *   2. Cola access_token (pedido à Pennacorp)
 *   3. UI chama POST /suppliers/:id/integrations/icarus (este service)
 *   4. Service encripta + insere + chama ping pra validar
 *   5. UI mostra status "Conectado"
 *
 * IMPORTANTE: nunca devolver access_token_encrypted no GET — só metadata.
 */

export interface ConnectInput {
  access_token:   string                          // plain — vai ser encriptado
  base_url?:      string                          // override (raro)
  rate_limit_rpm?: number                          // override
  sync_only_ecommerce?: boolean                    // filtro eComm padrão
  notes?:         string
}

export interface IntegrationStatus {
  id:                string
  supplier_id:       string
  organization_id:   string
  integration_type:  'icarus'
  is_active:         boolean
  last_synced_at:    string | null
  last_sync_status:  'success' | 'failed' | 'partial' | null
  last_sync_error:   string | null
  total_synced:      number
  config:            {
    base_url?:           string
    rate_limit_rpm?:     number
    sync_only_ecommerce?: boolean
    notes?:              string
  }
  created_at:        string
  updated_at:        string
}

interface DbRow {
  id:                     string
  organization_id:        string
  supplier_id:            string
  integration_type:       string
  access_token_encrypted: string
  config:                 Record<string, unknown> | null
  last_synced_at:         string | null
  last_sync_status:       string | null
  last_sync_error:        string | null
  total_synced:           number
  is_active:              boolean
  created_by:             string | null
  created_at:             string
  updated_at:             string
}

@Injectable()
export class IcarusIntegrationService {
  private readonly log = new Logger(IcarusIntegrationService.name)

  constructor(private readonly client: IcarusApiClient) {}

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /** Cria (ou reativa) integração Icarus pra um supplier. Faz ping antes
   *  de persistir pra falhar fast se o token for inválido.
   *
   *  Se já existe linha inativa pra esse supplier, REATIVA + atualiza token
   *  (em vez de duplicar). */
  async connect(
    orgId: string,
    supplierId: string,
    userId: string | null,
    input: ConnectInput,
  ): Promise<IntegrationStatus> {
    if (!input.access_token?.trim()) {
      throw new BadRequestException('access_token obrigatório')
    }
    const accessTokenPlain = input.access_token.trim()

    // Confere que o supplier existe e pertence à org
    const { data: supplier } = await supabaseAdmin
      .from('suppliers')
      .select('id, name')
      .eq('id', supplierId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!supplier) {
      throw new NotFoundException('Fornecedor não encontrado nessa organização')
    }

    // PING — falha fast se token inválido. Não persiste nada se 4xx/5xx.
    const clientConfig: IcarusClientConfig = {}
    if (input.base_url) clientConfig.baseUrl = input.base_url
    try {
      await this.client.ping(accessTokenPlain, clientConfig)
    } catch (e) {
      throw new BadRequestException(`Falha ao validar token Icarus: ${(e as Error).message}`)
    }

    const accessTokenEncrypted = encryptConfig({ token: accessTokenPlain })
    if (!accessTokenEncrypted) {
      throw new Error('Falha ao encriptar access_token (verifique MARKETPLACE_CONFIG_KEY)')
    }

    const config: Record<string, unknown> = {}
    if (input.base_url)             config.base_url             = input.base_url
    if (input.rate_limit_rpm)       config.rate_limit_rpm       = input.rate_limit_rpm
    if (input.sync_only_ecommerce != null) config.sync_only_ecommerce = input.sync_only_ecommerce
    if (input.notes)                config.notes                = input.notes

    // UPSERT por (supplier_id, integration_type): se já existe (mesmo
    // inativo), atualiza in-place pra evitar violar unique idx parcial.
    const { data: existing } = await supabaseAdmin
      .from('supplier_integrations')
      .select('id')
      .eq('supplier_id', supplierId)
      .eq('integration_type', 'icarus')
      .maybeSingle()

    let row: DbRow
    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('supplier_integrations')
        .update({
          access_token_encrypted: accessTokenEncrypted,
          config,
          is_active:              true,
          updated_at:             new Date().toISOString(),
          // Não reset last_synced_at — preserva histórico
        })
        .eq('id', existing.id as string)
        .select('*')
        .single()
      if (error || !data) throw new BadRequestException(error?.message ?? 'update falhou')
      row = data as DbRow
    } else {
      const { data, error } = await supabaseAdmin
        .from('supplier_integrations')
        .insert({
          organization_id:        orgId,
          supplier_id:            supplierId,
          integration_type:       'icarus',
          access_token_encrypted: accessTokenEncrypted,
          config,
          is_active:              true,
          created_by:             userId,
        })
        .select('*')
        .single()
      if (error || !data) throw new BadRequestException(error?.message ?? 'insert falhou')
      row = data as DbRow
    }

    return this.toStatus(row)
  }

  /** Lê uma integração pelo supplier (sem expor access_token). */
  async getBySupplier(orgId: string, supplierId: string): Promise<IntegrationStatus | null> {
    const { data, error } = await supabaseAdmin
      .from('supplier_integrations')
      .select('*')
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)
      .eq('integration_type', 'icarus')
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data) return null
    return this.toStatus(data as DbRow)
  }

  /** Lista todas integrações Icarus ativas da org. */
  async list(orgId: string): Promise<IntegrationStatus[]> {
    const { data, error } = await supabaseAdmin
      .from('supplier_integrations')
      .select('*')
      .eq('organization_id', orgId)
      .eq('integration_type', 'icarus')
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []).map(r => this.toStatus(r as DbRow))
  }

  /** Soft-disconnect: marca is_active=false. Mantém histórico. */
  async disconnect(orgId: string, supplierId: string): Promise<{ ok: true; disconnected: boolean }> {
    const { data, error } = await supabaseAdmin
      .from('supplier_integrations')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)
      .eq('integration_type', 'icarus')
      .select('id')
    if (error) throw new BadRequestException(error.message)
    return { ok: true, disconnected: (data?.length ?? 0) > 0 }
  }

  /** Faz ping com o token armazenado — útil pra UI mostrar status. */
  async test(orgId: string, supplierId: string): Promise<{
    ok:                    boolean
    base_url?:             string
    request_token_preview?: string
    error?:                string
  }> {
    const token = await this.getDecryptedToken(orgId, supplierId)
    if (!token) return { ok: false, error: 'Integração não encontrada ou inativa' }
    const clientConfig = this.buildClientConfig(token.config)
    try {
      const result = await this.client.ping(token.access_token, clientConfig)
      return { ok: true, base_url: result.base_url, request_token_preview: result.request_token_preview }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ── Helpers internos ────────────────────────────────────────────────────

  /** Recupera access_token plain + config pra uso interno (sync workers).
   *  NUNCA retornar daqui pro frontend. */
  async getDecryptedToken(orgId: string, supplierId: string): Promise<{
    access_token: string
    config:       Record<string, unknown>
    integration_id: string
  } | null> {
    const { data } = await supabaseAdmin
      .from('supplier_integrations')
      .select('id, access_token_encrypted, config')
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)
      .eq('integration_type', 'icarus')
      .eq('is_active', true)
      .maybeSingle()
    if (!data) return null
    const decrypted = decryptConfig(data.access_token_encrypted as string)
    const token = decrypted && typeof decrypted.token === 'string' ? decrypted.token : null
    if (!token) {
      this.log.warn(`[icarus-integration] falha ao decriptar token do supplier=${supplierId}`)
      return null
    }
    return {
      access_token:   token,
      config:         (data.config ?? {}) as Record<string, unknown>,
      integration_id: data.id as string,
    }
  }

  buildClientConfig(config: Record<string, unknown>): IcarusClientConfig {
    const out: IcarusClientConfig = {}
    if (typeof config.base_url === 'string') out.baseUrl = config.base_url
    // timeoutMs poderia vir aqui no futuro
    return out
  }

  private toStatus(row: DbRow): IntegrationStatus {
    return {
      id:                row.id,
      supplier_id:       row.supplier_id,
      organization_id:   row.organization_id,
      integration_type:  'icarus',
      is_active:         row.is_active,
      last_synced_at:    row.last_synced_at,
      last_sync_status:  (row.last_sync_status as IntegrationStatus['last_sync_status']) ?? null,
      last_sync_error:   row.last_sync_error,
      total_synced:      row.total_synced ?? 0,
      config:            (row.config ?? {}) as IntegrationStatus['config'],
      created_at:        row.created_at,
      updated_at:        row.updated_at,
    }
  }
}
