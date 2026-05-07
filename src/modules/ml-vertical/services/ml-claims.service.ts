import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'
import { AlertSignalsService } from '../../intelligence-hub/alert-signals.service'
import type { SignalDraft } from '../../intelligence-hub/analyzers/analyzers.types'
import type { MlClaimApiResponse } from '../ml-vertical.types'

const ML_BASE = 'https://api.mercadolibre.com'

export interface ClaimRow {
  id:               string
  organization_id:  string
  ml_claim_id:      number
  ml_resource_id:   number | null
  type:             string | null
  stage:            string | null
  status:           string | null
  reason_id:        string | null
  reason_name:      string | null
  date_created:     string
  last_updated:     string | null
  conversation_id:  string | null
  raw:              unknown
}

/**
 * Handler do webhook ML topic 'claims' + CRUD em ml_claims.
 *
 * Fluxo do handler:
 *   1. Fetch claim na API ML pra ter shape canônico
 *   2. Upsert em ml_claims (idempotente)
 *   3. Decide eventos disparados:
 *      - claim_opened: nova row criada
 *      - mediation_started: stage transitou pra 'mediation'
 *   4. Emite SignalDraft via AlertSignalsService → AlertEngine roteia pros
 *      managers via routing rules (analyzer='ml')
 */
@Injectable()
export class MlClaimsService {
  private readonly logger = new Logger(MlClaimsService.name)

  constructor(
    private readonly ml:      MercadolivreService,
    private readonly signals: AlertSignalsService,
  ) {}

  async handleClaimWebhook(orgId: string, sellerId: number, resource: string): Promise<void> {
    const claimId = this.extractClaimId(resource)
    if (!claimId) {
      this.logger.warn(`[ml-claims] resource sem claim_id: ${resource}`)
      return
    }

    let token: string
    try {
      const res = await this.ml.getTokenForOrg(orgId, sellerId)
      token = res.token
    } catch (e) {
      this.logger.warn(`[ml-claims] sem token org=${orgId} seller=${sellerId}: ${(e as Error).message}`)
      return
    }

    let claim: MlClaimApiResponse
    try {
      const { data } = await axios.get<MlClaimApiResponse>(
        `${ML_BASE}/post-purchase/v1/claims/${claimId}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
      )
      claim = data
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status
      this.logger.warn(`[ml-claims] fetch claim=${claimId} falhou status=${status}: ${(e as Error).message}`)
      return
    }

    // Captura estado anterior pra detectar mediation_started
    const { data: prevRow } = await supabaseAdmin
      .from('ml_claims')
      .select('stage, status')
      .eq('organization_id', orgId)
      .eq('ml_claim_id', claim.id)
      .maybeSingle()
    const prev = prevRow as { stage: string | null; status: string | null } | null

    // Tenta amarrar em uma conversation existente pelo resource_id (pack_id ou order_id)
    let conversationId: string | null = null
    if (claim.resource_id) {
      const { data: conv } = await supabaseAdmin
        .from('ml_conversations')
        .select('id')
        .eq('organization_id', orgId)
        .or(`pack_id.eq.${claim.resource_id},order_id.eq.${claim.resource_id}`)
        .maybeSingle()
      conversationId = (conv as { id: string } | null)?.id ?? null
    }

    const upsertPayload = {
      organization_id: orgId,
      ml_claim_id:     claim.id,
      ml_resource_id:  claim.resource_id ?? null,
      type:            claim.type ?? null,
      stage:           claim.stage ?? null,
      status:          claim.status ?? null,
      reason_id:       claim.reason_id ?? null,
      reason_name:     claim.reason?.name ?? null,
      date_created:    claim.date_created,
      last_updated:    claim.last_updated ?? null,
      conversation_id: conversationId,
      raw:             claim as unknown,
    }
    const { data: rowData, error: rowErr } = await supabaseAdmin
      .from('ml_claims')
      .upsert(upsertPayload, { onConflict: 'organization_id,ml_claim_id' })
      .select('*')
      .single()
    if (rowErr || !rowData) {
      this.logger.warn(`[ml-claims] upsert falhou claim=${claim.id}: ${rowErr?.message ?? 'no row'}`)
      return
    }
    const row = rowData as ClaimRow

    // Detectar eventos
    const isNew              = !prev
    const becameMediation    = !!(prev && prev.stage !== 'mediation' && claim.stage === 'mediation')

    if (isNew) {
      await this.emitClaimOpened(row)
    }
    if (becameMediation) {
      await this.emitMediationStarted(row)
    }
  }

  private async emitClaimOpened(row: ClaimRow): Promise<void> {
    const draft: SignalDraft = {
      analyzer:    'ml',
      category:    'claim_opened',
      severity:    'critical',
      score:       90,
      entity_type: 'order',
      entity_id:   row.ml_resource_id ? String(row.ml_resource_id) : null,
      entity_name: null,
      data: {
        claim_id:       row.id,
        ml_claim_id:    row.ml_claim_id,
        ml_resource_id: row.ml_resource_id,
        reason_name:    row.reason_name,
        type:           row.type,
        stage:          row.stage,
        conversation_id: row.conversation_id,
      },
      summary_pt: `🚨 Nova reclamação no ML${row.reason_name ? ` — motivo: ${row.reason_name}` : ''}`,
      suggestion_pt: 'Abra a inbox de pós-venda e responda o comprador o quanto antes pra preservar SLA.',
    }
    await this.signals.insertMany(row.organization_id, [draft])
  }

  private async emitMediationStarted(row: ClaimRow): Promise<void> {
    const draft: SignalDraft = {
      analyzer:    'ml',
      category:    'mediation_started',
      severity:    'critical',
      score:       95,
      entity_type: 'order',
      entity_id:   row.ml_resource_id ? String(row.ml_resource_id) : null,
      entity_name: null,
      data: {
        claim_id:       row.id,
        ml_claim_id:    row.ml_claim_id,
        ml_resource_id: row.ml_resource_id,
        reason_name:    row.reason_name,
        conversation_id: row.conversation_id,
      },
      summary_pt: `🚨 Mediação iniciada no ML${row.reason_name ? ` — motivo: ${row.reason_name}` : ''}`,
      suggestion_pt: 'Responda no painel de mediação do ML imediatamente. Mediação demora pode virar disputa.',
    }
    await this.signals.insertMany(row.organization_id, [draft])
  }

  private extractClaimId(resource: string): string | null {
    // resource: "/post-purchase/v1/claims/{id}" ou "/claims/{id}"
    const m = resource.match(/\/claims\/(\d+)/)
    return m?.[1] ?? null
  }

  // ── Métodos públicos pra controllers ────────────────────────────────────

  async listForOrg(orgId: string, filters: { status?: string; stage?: string; days?: number; limit?: number } = {}) {
    let q = supabaseAdmin
      .from('ml_claims')
      .select('*')
      .eq('organization_id', orgId)
      .order('date_created', { ascending: false })
      .limit(filters.limit ?? 100)
    if (filters.status) q = q.eq('status', filters.status)
    if (filters.stage)  q = q.eq('stage',  filters.stage)
    if (filters.days) {
      const since = new Date(Date.now() - filters.days * 86_400_000).toISOString()
      q = q.gte('date_created', since)
    }
    const { data, error } = await q
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as ClaimRow[]
  }

  async findOne(orgId: string, id: string): Promise<ClaimRow | null> {
    const { data, error } = await supabaseAdmin
      .from('ml_claims')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    return (data as ClaimRow | null) ?? null
  }

  async findOpenByConversation(orgId: string, conversationId: string): Promise<ClaimRow | null> {
    const { data } = await supabaseAdmin
      .from('ml_claims')
      .select('*')
      .eq('organization_id', orgId)
      .eq('conversation_id', conversationId)
      .neq('status', 'closed')
      .order('date_created', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as ClaimRow | null) ?? null
  }
}
