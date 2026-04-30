import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { CredentialsService } from '../credentials/credentials.service'
import { FEATURE_REGISTRY, FeatureKey, Provider } from './defaults'
import { GenerateTextInput, GenerateTextOutput, FeatureSettingRow } from './types'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL    = 'https://api.openai.com/v1/chat/completions'

/** Pricing in USD per 1M tokens. Aligned com src/constants/ai-models.ts —
 * mantém as duas tabelas em sync quando atualizar preços. Modelos fora
 * dessa tabela cobram costUsd = 0 (ainda logam, contabilidade
 * aproximada). */
const PRICING: Record<string, { in: number; out: number }> = {
  // Anthropic — USD por 1M tokens
  'claude-haiku-4-5-20251001': { in: 0.25, out: 1.25  },
  'claude-sonnet-4-6':         { in: 3.00, out: 15.00 },
  'claude-opus-4-7':           { in: 15.0, out: 75.00 },
  // OpenAI
  'gpt-5-nano':                { in: 0.15, out: 0.60  },
  'gpt-5-mini':                { in: 0.30, out: 2.40  },
  'gpt-5':                     { in: 2.50, out: 10.00 },
  'text-embedding-3-small':    { in: 0.02, out: 0     },
  'text-embedding-3-large':    { in: 0.13, out: 0     },
}

interface ResolvedConfig {
  primary:  { provider: Provider; model: string }
  fallback: { provider: Provider; model: string } | null
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name)

  constructor(private readonly credentials: CredentialsService) {}

  /** Generate text using the configured provider/model for this feature.
   * Resolves config (override > org settings > registry default), tries
   * primary, falls back on 5xx/network errors, logs cost + tokens to
   * ai_usage_log. Throws on auth/4xx errors (caller decides how to handle).
   *
   * AI-ABS-2: try/finally garante que TODA chamada loga em ai_usage_log,
   * mesmo se primary + fallback falharem. Falhas levam error_message
   * preenchido + tokens_*=0 + cost_usd=0. */
  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const t0 = Date.now()

    if (!input.userPrompt || input.userPrompt.trim().length === 0) {
      throw new BadRequestException('userPrompt obrigatório')
    }

    const config = await this.resolveConfig(input)
    let out:           GenerateTextOutput | null = null
    let lastConfig:    { provider: Provider; model: string } = config.primary
    let fallbackUsed = false
    let errorMessage:  string | null = null
    let toThrow:       unknown        = null

    try {
      // Try primary
      try {
        const result = await this.callProvider({
          provider:    config.primary.provider,
          model:       config.primary.model,
          orgId:       input.orgId,
          systemPrompt: input.systemPrompt,
          userPrompt:  input.userPrompt,
          maxTokens:   input.maxTokens   ?? 800,
          temperature: input.temperature,
          jsonMode:    input.jsonMode    ?? false,
        })
        out = this.finalize(config.primary, result, t0, false)
        return out
      } catch (e) {
        const isRetryable = this.isRetryableError(e)
        if (!isRetryable || !config.fallback) {
          errorMessage = `${config.primary.provider}/${config.primary.model}: ${this.errorStatus(e)}`
          toThrow = e
          throw e
        }
        this.logger.warn(`[llm] primary ${config.primary.provider}/${config.primary.model} falhou (${this.errorStatus(e)}) — tentando fallback`)
      }

      // Try fallback (only reached when primary threw a retryable error AND fallback exists)
      lastConfig   = config.fallback!
      fallbackUsed = true
      try {
        const result = await this.callProvider({
          provider:    config.fallback!.provider,
          model:       config.fallback!.model,
          orgId:       input.orgId,
          systemPrompt: input.systemPrompt,
          userPrompt:  input.userPrompt,
          maxTokens:   input.maxTokens   ?? 800,
          temperature: input.temperature,
          jsonMode:    input.jsonMode    ?? false,
        })
        out = this.finalize(config.fallback!, result, t0, true)
        return out
      } catch (e) {
        errorMessage = `${config.fallback!.provider}/${config.fallback!.model} (fallback): ${this.errorStatus(e)}`
        toThrow = e
        throw e
      }
    } finally {
      // SEMPRE loga, sucesso ou falha (AI-ABS-2 Bug 4)
      if (out) {
        await this.logUsage(out, input.feature, input.orgId, null)
      } else {
        // Failure path — sintetiza output zero pra logar
        const failOut: GenerateTextOutput = {
          text:         '',
          provider:     lastConfig.provider,
          model:        lastConfig.model,
          inputTokens:  0,
          outputTokens: 0,
          costUsd:      0,
          latencyMs:    Date.now() - t0,
          fallbackUsed,
        }
        await this.logUsage(failOut, input.feature, input.orgId, errorMessage)
      }
      // void toThrow — o throw original já está no path do try
      void toThrow
    }
  }

  // ── Config resolution ────────────────────────────────────────────────────

  private async resolveConfig(input: GenerateTextInput): Promise<ResolvedConfig> {
    if (input.override) {
      return { primary: input.override, fallback: null }
    }

    // 1. Override via ai_feature_settings
    const { data } = await supabaseAdmin
      .from('ai_feature_settings')
      .select('*')
      .eq('organization_id', input.orgId)
      .eq('feature_key', input.feature)
      .eq('enabled', true)
      .maybeSingle()

    if (data) {
      const row = data as FeatureSettingRow
      return {
        primary:  { provider: row.primary_provider, model: row.primary_model },
        fallback: row.fallback_provider && row.fallback_model
          ? { provider: row.fallback_provider, model: row.fallback_model }
          : null,
      }
    }

    // 2. Default from registry
    const reg = FEATURE_REGISTRY[input.feature]
    if (!reg) throw new BadRequestException(`feature desconhecida: ${input.feature}`)
    return {
      primary:  { provider: reg.primary.provider as Provider, model: reg.primary.model },
      fallback: reg.fallback
        ? { provider: reg.fallback.provider as Provider, model: reg.fallback.model }
        : null,
    }
  }

  // ── Provider dispatch ───────────────────────────────────────────────────

  private async callProvider(args: {
    provider:     Provider
    model:        string
    orgId:        string
    systemPrompt?: string
    userPrompt:   string
    maxTokens:    number
    temperature?: number
    jsonMode:     boolean
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const keyName = args.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
    // Try org-scoped key first, then null (global) fallback
    const key = await this.credentials.getDecryptedKey(args.orgId, args.provider, keyName).catch(() => null)
      ?? await this.credentials.getDecryptedKey(null, args.provider, keyName).catch(() => null)
    if (!key) throw new BadRequestException(`${keyName} não configurada`)

    if (args.provider === 'anthropic') {
      return this.callAnthropic(key, args.model, args.systemPrompt, args.userPrompt, args.maxTokens, args.temperature)
    }
    return this.callOpenAI(key, args.model, args.systemPrompt, args.userPrompt, args.maxTokens, args.temperature, args.jsonMode)
  }

  private async callAnthropic(
    apiKey: string,
    model: string,
    systemPrompt: string | undefined,
    userPrompt: string,
    maxTokens: number,
    temperature?: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: userPrompt }],
    }
    if (systemPrompt) body.system = systemPrompt
    if (typeof temperature === 'number') body.temperature = temperature

    const res = await axios.post<{
      content: Array<{ type: string; text?: string }>
      usage:   { input_tokens: number; output_tokens: number }
    }>(ANTHROPIC_URL, body, {
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 60_000,
    })
    const text = (res.data.content ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('')
      .trim()
    return {
      text,
      inputTokens:  res.data.usage?.input_tokens  ?? 0,
      outputTokens: res.data.usage?.output_tokens ?? 0,
    }
  }

  private async callOpenAI(
    apiKey: string,
    model: string,
    systemPrompt: string | undefined,
    userPrompt: string,
    maxTokens: number,
    temperature: number | undefined,
    jsonMode: boolean,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    messages.push({ role: 'user', content: userPrompt })

    const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages }
    if (typeof temperature === 'number') body.temperature = temperature
    if (jsonMode) body.response_format = { type: 'json_object' }

    const res = await axios.post<{
      choices: Array<{ message: { content: string | null } }>
      usage:   { prompt_tokens: number; completion_tokens: number }
    }>(OPENAI_URL, body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      timeout: 60_000,
    })
    const text = (res.data.choices?.[0]?.message?.content ?? '').trim()
    return {
      text,
      inputTokens:  res.data.usage?.prompt_tokens     ?? 0,
      outputTokens: res.data.usage?.completion_tokens ?? 0,
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private finalize(
    config:      { provider: Provider; model: string },
    result:      { text: string; inputTokens: number; outputTokens: number },
    t0:          number,
    fallbackUsed: boolean,
  ): GenerateTextOutput {
    const price = PRICING[config.model]
    const costUsd = price
      ? (result.inputTokens / 1_000_000) * price.in + (result.outputTokens / 1_000_000) * price.out
      : 0
    return {
      text:         result.text,
      provider:     config.provider,
      model:        config.model,
      inputTokens:  result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd:      Math.round(costUsd * 1_000_000) / 1_000_000,
      latencyMs:    Date.now() - t0,
      fallbackUsed,
    }
  }

  private async logUsage(
    out:           GenerateTextOutput,
    feature:       FeatureKey,
    orgId:         string,
    errorMessage:  string | null,
  ): Promise<void> {
    try {
      await supabaseAdmin.from('ai_usage_log').insert({
        organization_id: orgId,
        provider:        out.provider,
        model:           out.model,
        feature,
        tokens_input:    out.inputTokens,
        tokens_output:   out.outputTokens,
        tokens_total:    out.inputTokens + out.outputTokens,
        cost_usd:        out.costUsd,
        latency_ms:      out.latencyMs,
        fallback_used:   out.fallbackUsed,
        error_message:   errorMessage,         // AI-ABS-2 Bug 4: NULL em sucesso, mensagem em falha
      })
    } catch (e) {
      this.logger.warn(`[llm.logUsage] insert falhou: ${(e as Error).message}`)
    }
  }

  /** 5xx / network errors qualificam pra fallback. 4xx (auth/quota) e erros
   * non-axios (validation, programmer errors) propagam direto sem fallback.
   *
   * AI-ABS-2 Bug 3: antes retornava `true` pra non-axios errors — isso fazia
   * BadRequestException do próprio LlmService disparar fallback path,
   * mascarando erros reais. Agora `false` por default. */
  private isRetryableError(e: unknown): boolean {
    if (!axios.isAxiosError(e)) return false           // validation / programmer → propagate
    const ax = e as AxiosError
    if (!ax.response) return true                       // timeout / no response → retry
    const status = ax.response.status
    return status >= 500 && status < 600                // 5xx → retry
  }

  private errorStatus(e: unknown): string {
    if (axios.isAxiosError(e)) {
      return `HTTP ${(e as AxiosError).response?.status ?? 'no-status'}`
    }
    return (e as Error).message ?? 'unknown'
  }
}
