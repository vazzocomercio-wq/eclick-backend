import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MlAiCoreService } from '../../ml-ai-core/ml-ai-core.service'
import { AlertSignalsService } from '../../intelligence-hub/alert-signals.service'
import type { SignalDraft } from '../../intelligence-hub/analyzers/analyzers.types'
import { matchClaimRemovalKeywords } from '../helpers/claim-removal-keywords'
import { MlClaimsService } from './ml-claims.service'

interface ConversationRow {
  id:                  string
  organization_id:     string
  buyer_nickname:      string | null
}

interface MessageRow {
  id:                  string
  text:                string
  conversation_id:     string
}

export interface CandidateRow {
  id:                       string
  organization_id:          string
  claim_id:                 string
  conversation_id:          string | null
  trigger_message_id:       string | null
  matched_keywords:         string[]
  llm_confidence:           'low' | 'medium' | 'high' | null
  llm_reason:               string | null
  llm_suggested_action:     string | null
  suggested_request_text:   string | null
  status:                   string
  llm_metadata:             Record<string, unknown> | null
  dismissed_by:             string | null
  dismissed_at:             string | null
  requested_at:             string | null
  created_at:               string
}

/**
 * Detector híbrido regex + LLM. Chamado pelo MlPostsaleService toda vez
 * que uma mensagem nova do comprador é persistida.
 *
 * Fluxo:
 *   1. Filtro: só roda se conversation tem claim aberto (poupa LLM)
 *   2. Regex: zero matches → retorna sem fazer nada
 *   3. LLM qualifica (Haiku via MlAiCoreService.analyzeClaimRemoval)
 *   4. Persiste em claim_removal_candidates se confidence ≥ medium e
 *      isCandidate=true
 *   5. Emite SignalDraft via AlertSignalsService → AlertEngine
 */
@Injectable()
export class MlClaimRemovalService {
  private readonly logger = new Logger(MlClaimRemovalService.name)

  constructor(
    private readonly aiCore:  MlAiCoreService,
    private readonly signals: AlertSignalsService,
    private readonly claims:  MlClaimsService,
  ) {}

  async analyzeMessage(
    orgId:      string,
    message:    MessageRow,
    conversation: ConversationRow,
  ): Promise<void> {
    if (!message.text?.trim()) return

    // 1. Filtro de claim aberto
    const claim = await this.claims.findOpenByConversation(orgId, conversation.id)
    if (!claim) return

    // 2. Regex match (poupa LLM se nenhuma keyword)
    const matches = matchClaimRemovalKeywords(message.text)
    if (matches.length === 0) return

    // 3. Histórico curto (5 últimas msgs) pra contexto LLM
    const history = await this.fetchRecentHistory(conversation.id, 5)

    // 4. LLM qualifica
    let analysis
    try {
      analysis = await this.aiCore.analyzeClaimRemoval(orgId, {
        message:           message.text,
        matchedKeywords:   matches,
        claimReason:       claim.reason_name,
        claimDaysOpen:     daysSince(claim.date_created),
        shippingStatus:    null, // pode ser enriquecido depois com order
        conversationSummary: history,
      })
    } catch (e) {
      this.logger.warn(`[claim-removal] LLM falhou msg=${message.id}: ${(e as Error).message}`)
      return
    }

    // 5. Persist + signal só se isCandidate=true e confidence >= medium
    if (!analysis.isCandidate || analysis.confidence === 'low') return

    const { data: candidate, error } = await supabaseAdmin
      .from('claim_removal_candidates')
      .insert({
        organization_id:        orgId,
        claim_id:               claim.id,
        conversation_id:        conversation.id,
        trigger_message_id:     message.id,
        matched_keywords:       matches,
        llm_confidence:         analysis.confidence,
        llm_reason:             analysis.reason,
        llm_suggested_action:   analysis.suggestedAction,
        suggested_request_text: analysis.suggestedRequestText,
        status:                 'pending',
        llm_metadata: {
          provider:    analysis.llm.provider,
          model:       analysis.llm.model,
          input_tokens:  analysis.llm.inputTokens,
          output_tokens: analysis.llm.outputTokens,
          cost_usd:    analysis.llm.costUsd,
          latency_ms:  analysis.llm.latencyMs,
        },
      })
      .select('*')
      .single()
    if (error || !candidate) {
      this.logger.warn(`[claim-removal] insert candidate falhou: ${error?.message ?? 'no row'}`)
      return
    }

    const cand = candidate as CandidateRow
    const buyerLabel = conversation.buyer_nickname ?? 'comprador'
    const draft: SignalDraft = {
      analyzer:    'ml',
      category:    'claim_removal_candidate',
      severity:    analysis.confidence === 'high' ? 'critical' : 'warning',
      score:       analysis.confidence === 'high' ? 75 : 55,
      entity_type: null,
      entity_id:   cand.id,
      entity_name: null,
      data: {
        candidate_id:  cand.id,
        claim_id:      claim.id,
        ml_claim_id:   claim.ml_claim_id,
        conversation_id: conversation.id,
        confidence:    analysis.confidence,
        matched:       matches,
      },
      summary_pt:
        `🔓 Possível exclusão de reclamação — ${buyerLabel}\n` +
        `${analysis.reason}\n\n` +
        `Confiança: ${analysis.confidence}`,
      suggestion_pt: analysis.suggestedAction || 'Revise a conversa e considere abrir solicitação de exclusão no ML.',
    }
    await this.signals.insertMany(orgId, [draft])
  }

  // ── Métodos pra controller ─────────────────────────────────────────────

  async listForOrg(orgId: string, filters: { status?: string; confidence?: string; limit?: number } = {}) {
    let q = supabaseAdmin
      .from('claim_removal_candidates')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(filters.limit ?? 100)
    if (filters.status)     q = q.eq('status', filters.status)
    if (filters.confidence) q = q.eq('llm_confidence', filters.confidence)
    const { data, error } = await q
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as CandidateRow[]
  }

  async findOne(orgId: string, id: string): Promise<CandidateRow> {
    const { data, error } = await supabaseAdmin
      .from('claim_removal_candidates')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data)  throw new NotFoundException(`Candidate ${id} não encontrado`)
    return data as CandidateRow
  }

  async dismiss(orgId: string, id: string, userId: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('claim_removal_candidates')
      .update({
        status:        'dismissed',
        dismissed_by:  userId,
        dismissed_at:  new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  async markRequested(orgId: string, id: string): Promise<{ ok: true; suggested_request_text: string | null }> {
    const cand = await this.findOne(orgId, id)
    const { error } = await supabaseAdmin
      .from('claim_removal_candidates')
      .update({
        status:        'requested',
        requested_at:  new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true, suggested_request_text: cand.suggested_request_text ?? null }
  }

  /** Re-pede LLM pra gerar novo texto de solicitação. */
  async regenerateRequestText(orgId: string, id: string): Promise<{ ok: true; suggested_request_text: string | null }> {
    const cand = await this.findOne(orgId, id)
    if (!cand.trigger_message_id) {
      throw new BadRequestException('Candidate sem trigger_message_id — impossível regenerar')
    }

    const { data: msgRow } = await supabaseAdmin
      .from('ml_messages')
      .select('text')
      .eq('id', cand.trigger_message_id)
      .maybeSingle()
    const message = (msgRow as { text?: string } | null)?.text ?? ''

    const claim = await this.claims.findOne(orgId, cand.claim_id)
    if (!claim) throw new NotFoundException('Claim relacionado não encontrado')

    const history = cand.conversation_id
      ? await this.fetchRecentHistory(cand.conversation_id, 5)
      : null

    const analysis = await this.aiCore.analyzeClaimRemoval(orgId, {
      message,
      matchedKeywords:    cand.matched_keywords,
      claimReason:        claim.reason_name,
      claimDaysOpen:      daysSince(claim.date_created),
      shippingStatus:     null,
      conversationSummary: history,
    })

    const { error } = await supabaseAdmin
      .from('claim_removal_candidates')
      .update({
        suggested_request_text: analysis.suggestedRequestText,
        llm_reason:             analysis.reason,
        llm_suggested_action:   analysis.suggestedAction,
        llm_confidence:         analysis.confidence,
      })
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)

    return { ok: true, suggested_request_text: analysis.suggestedRequestText }
  }

  private async fetchRecentHistory(conversationId: string, limit: number): Promise<string> {
    const { data } = await supabaseAdmin
      .from('ml_messages')
      .select('direction, text, sent_at')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: false })
      .limit(limit + 1)
    const rows = ((data ?? []) as Array<{ direction: string; text: string }>).reverse()
    return rows.map(r => `${r.direction === 'buyer' ? 'C' : 'V'}: ${r.text.slice(0, 200)}`).join('\n')
  }
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}
