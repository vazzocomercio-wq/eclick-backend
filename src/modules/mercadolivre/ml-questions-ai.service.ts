import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from './mercadolivre.service'
import { LlmService } from '../ai/llm.service'

const ML_BASE = 'https://api.mercadolibre.com'

export type TransformAction = 'shorten' | 'humanize' | 'add_warranty' | 'ready_response'

const TRANSFORM_PROMPTS: Record<TransformAction, string> = {
  shorten:        'Reescreva mais curto (máx 2 linhas), mantendo o conteúdo essencial. Sem markdown.',
  humanize:       'Reescreva com tom mais humano e amigável, como um vendedor prestativo. Sem markdown.',
  add_warranty:   'Adicione ao texto uma menção à garantia do produto e suporte pós-venda. Sem markdown.',
  ready_response: 'Reescreva como resposta definitiva pronta para envio, direta e profissional. Sem markdown.',
}

const AUTO_SEND_FEATURE_KEY = 'ml_question_auto_send'

@Injectable()
export class MlQuestionsAiService {
  private readonly logger = new Logger(MlQuestionsAiService.name)

  constructor(
    private readonly ml: MercadolivreService,
    private readonly llm: LlmService,
  ) {}

  // ── Parte A — Transformações sobre texto editado ────────────────────────

  async transformText(orgId: string, text: string, action: TransformAction): Promise<{ transformed: string }> {
    if (!text?.trim()) throw new BadRequestException('text obrigatório')
    if (!TRANSFORM_PROMPTS[action]) throw new BadRequestException(`action inválida: ${action}`)

    const result = await this.llm.generateText({
      orgId,
      feature:      'ml_question_transform',
      systemPrompt: TRANSFORM_PROMPTS[action],
      userPrompt:   text.trim(),
      maxTokens:    400,
    })

    return { transformed: result.text.trim() }
  }

  // ── Parte B — Sugestão + envio aprovado ─────────────────────────────────

  async suggestAnswer(orgId: string, questionId: string): Promise<{
    suggestedAnswer: string
    confidence: number
    autoSendEligible: boolean
  }> {
    const { token } = await this.ml.getTokenForOrg(orgId)

    const { data: question } = await axios.get(`${ML_BASE}/questions/${questionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!question?.text || !question?.item_id) {
      throw new BadRequestException('Pergunta não encontrada ou sem item_id')
    }

    const { data: item } = await axios.get(`${ML_BASE}/items/${question.item_id}`, {
      headers: { Authorization: `Bearer ${token}` },
      params:  { attributes: 'title,price,condition,available_quantity' },
    })

    let history: Array<{ question: string; answer: string }> = []
    try {
      const { data: hist } = await axios.get(`${ML_BASE}/questions/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { item_id: question.item_id, status: 'ANSWERED', limit: 20 },
      })
      const raw = (hist?.questions ?? []) as Array<{ text?: string; answer?: { text?: string } }>
      history = raw
        .filter(q => q.answer?.text && q.text)
        .map(q => ({ question: q.text!, answer: q.answer!.text! }))
        .slice(0, 10)
    } catch {
      // histórico é opcional — segue sem
    }

    const { data: agent } = await supabaseAdmin
      .from('ai_agents')
      .select('id, system_prompt, name')
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()

    const systemPrompt =
      `Você é assistente de vendas do Mercado Livre.\n` +
      `${agent?.system_prompt ?? 'Seja objetivo e profissional.'}\n` +
      `REGRAS: responda só sobre o produto, sem markdown, máx 3 linhas, português brasileiro, sem mencionar concorrentes.`

    const historyBlock = history.length > 0
      ? 'HISTÓRICO P&R:\n' + history.map(h => `P:${h.question}\nR:${h.answer}`).join('\n')
      : 'HISTÓRICO P&R: (sem histórico)'

    const userPrompt =
      `PRODUTO: ${item?.title ?? '?'} | R$${item?.price ?? '?'} | ${item?.condition ?? 'novo'} | ${item?.available_quantity ?? 0} em estoque\n` +
      `${historyBlock}\n` +
      `PERGUNTA: ${question.text}\n` +
      `Responda de forma direta e precisa.`

    const llmOut = await this.llm.generateText({
      orgId,
      feature:      'ml_question_suggest',
      systemPrompt,
      userPrompt,
      maxTokens:    300,
    })

    const suggestedAnswer = llmOut.text.trim()

    const lower = suggestedAnswer.toLowerCase()
    let confidence = 0.9
    if (suggestedAnswer.length < 20) {
      confidence = 0.5
    } else if (
      lower.includes('não sei') ||
      lower.includes('não tenho') ||
      lower.includes('não posso informar') ||
      lower.includes('verificar com o vendedor')
    ) {
      confidence = 0.7
    }

    const autoSendEligible = confidence >= 0.70

    await supabaseAdmin
      .from('ml_question_suggestions')
      .upsert({
        organization_id:    orgId,
        question_id:        questionId,
        item_id:            question.item_id,
        question_text:      question.text,
        suggested_answer:   suggestedAnswer,
        confidence,
        auto_send_eligible: autoSendEligible,
        agent_id:           agent?.id ?? null,
        context_used:       { history_count: history.length, item_title: item?.title ?? null },
        status:             'pending',
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'organization_id,question_id' })

    return { suggestedAnswer, confidence, autoSendEligible }
  }

  async approveAndSend(orgId: string, questionId: string, finalAnswer: string, wasEdited: boolean) {
    if (!finalAnswer?.trim()) throw new BadRequestException('finalAnswer obrigatório')

    await this.ml.answerQuestion(orgId, Number(questionId), finalAnswer.trim())

    await supabaseAdmin
      .from('ml_question_suggestions')
      .update({
        status:       wasEdited ? 'edited' : 'approved',
        final_answer: finalAnswer.trim(),
        used_as_is:   !wasEdited,
        updated_at:   new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('question_id', questionId)

    return { ok: true }
  }

  async pollAndSuggest(orgId: string): Promise<{ processed: number; auto_sent: number }> {
    let processed = 0
    let autoSent  = 0

    try {
      const data = await this.ml.getQuestions(orgId, 'UNANSWERED')
      const questions = (data?.questions ?? []) as Array<{ id: number | string; item_id?: string }>
      if (!questions.length) return { processed: 0, auto_sent: 0 }

      const ids = questions.map(q => String(q.id))
      const { data: existing } = await supabaseAdmin
        .from('ml_question_suggestions')
        .select('question_id')
        .eq('organization_id', orgId)
        .in('question_id', ids)
      const existingIds = new Set(((existing ?? []) as Array<{ question_id: string }>).map(r => r.question_id))

      const fresh = questions.filter(q => !existingIds.has(String(q.id)))
      if (!fresh.length) return { processed: 0, auto_sent: 0 }

      const autoSendOn = await this.getAutoSendEnabled(orgId)

      for (const q of fresh) {
        try {
          const r = await this.suggestAnswer(orgId, String(q.id))
          processed++

          if (autoSendOn && r.autoSendEligible) {
            try {
              await this.ml.answerQuestion(orgId, Number(q.id), r.suggestedAnswer)
              await supabaseAdmin
                .from('ml_question_suggestions')
                .update({
                  status:       'auto_sent',
                  final_answer: r.suggestedAnswer,
                  used_as_is:   true,
                  updated_at:   new Date().toISOString(),
                })
                .eq('organization_id', orgId)
                .eq('question_id', String(q.id))
              autoSent++
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              this.logger.warn(`[auto-send] q=${q.id} falhou: ${msg}`)
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this.logger.warn(`[suggest] q=${q.id} falhou: ${msg}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[poll] org=${orgId} falhou: ${msg}`)
    }

    return { processed, auto_sent: autoSent }
  }

  @Cron('*/5 * * * *', { name: 'ml-questions-ai-poll' })
  async pollAllOrgs() {
    try {
      const { data: rows } = await supabaseAdmin
        .from('ml_connections')
        .select('organization_id')

      const orgs = [...new Set(
        ((rows ?? []) as Array<{ organization_id: string | null }>)
          .map(r => r.organization_id)
          .filter((x): x is string => !!x),
      )]

      let totalProc = 0, totalSent = 0
      for (const orgId of orgs) {
        const { processed, auto_sent } = await this.pollAndSuggest(orgId)
        totalProc += processed
        totalSent += auto_sent
      }
      if (totalProc > 0 || totalSent > 0) {
        this.logger.log(`[ml-questions-ai-poll] orgs=${orgs.length} processed=${totalProc} auto_sent=${totalSent}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[ml-questions-ai-poll] erro: ${msg}`)
    }
  }

  // ── Auto-send toggle (ai_feature_settings flag-only) ────────────────────

  async getAutoSendEnabled(orgId: string): Promise<boolean> {
    const { data } = await supabaseAdmin
      .from('ai_feature_settings')
      .select('enabled')
      .eq('organization_id', orgId)
      .eq('feature_key', AUTO_SEND_FEATURE_KEY)
      .maybeSingle()
    return data?.enabled === true
  }

  async setAutoSendEnabled(orgId: string, enabled: boolean) {
    const { error } = await supabaseAdmin
      .from('ai_feature_settings')
      .upsert({
        organization_id:   orgId,
        feature_key:       AUTO_SEND_FEATURE_KEY,
        primary_provider:  'anthropic',
        primary_model:     'claude-haiku-4-5-20251001',
        fallback_provider: null,
        fallback_model:    null,
        enabled,
        updated_at:        new Date().toISOString(),
      }, { onConflict: 'organization_id,feature_key' })
    if (error) throw new BadRequestException(error.message)
    return { enabled }
  }

  // ── Parte C — Stats de aprovação IA (30d) + auto-respostas (24h) ────────

  async getAiStats(orgId: string): Promise<{
    total_sent:    number
    used_as_is:    number
    edited:        number
    rejected:      number
    approval_rate: number | null
    auto_sent_24h: number
  }> {
    const since   = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const last24h = new Date(Date.now() -      86_400_000).toISOString()

    const { data } = await supabaseAdmin
      .from('ml_question_suggestions')
      .select('status, used_as_is, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', since)

    const rows = (data ?? []) as Array<{ status: string; used_as_is: boolean | null; created_at: string }>

    const sentStatuses = new Set(['approved', 'edited', 'auto_sent', 'sent'])
    const decided      = rows.filter(r => r.status !== 'pending')

    const total_sent = rows.filter(r => sentStatuses.has(r.status)).length
    const used_as_is = rows.filter(r => r.used_as_is === true).length
    const edited     = rows.filter(r => r.status === 'edited').length
    const rejected   = rows.filter(r => r.status === 'rejected').length

    const approval_rate = decided.length > 0
      ? Math.round((used_as_is / decided.length) * 1000) / 10
      : null

    const auto_sent_24h = rows.filter(r => r.status === 'auto_sent' && r.created_at >= last24h).length

    return { total_sent, used_as_is, edited, rejected, approval_rate, auto_sent_24h }
  }
}
