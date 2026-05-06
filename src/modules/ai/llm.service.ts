import { Injectable, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import * as FormData from 'form-data'
import { supabaseAdmin } from '../../common/supabase'
import { CredentialsService } from '../credentials/credentials.service'
import { FEATURE_REGISTRY, FeatureKey, Provider } from './defaults'
import { GenerateTextInput, GenerateTextOutput, GenerateImageInput, GenerateImageOutput, FeatureSettingRow, ImageFormat } from './types'

const ANTHROPIC_URL  = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL     = 'https://api.openai.com/v1/chat/completions'
const OPENAI_IMG_GEN = 'https://api.openai.com/v1/images/generations'
const OPENAI_IMG_EDT = 'https://api.openai.com/v1/images/edits'

const IMAGE_PRICING: Record<string, number> = {
  'gpt-image-1': 0.040,    // standard quality, USD/imagem
  'flux-pro':    0.050,    // referencial — não usado nesta sprint
}

const FORMAT_SIZE: Record<Exclude<ImageFormat, 'custom'>, string> = {
  square: '1024x1024',  // 1:1  — 1080×1080 lógico
  story:  '1024x1536',  // 9:16 — 1080×1920 lógico (OpenAI vertical)
  wide:   '1536x1024',  // 16:9 — 1920×1080 lógico (OpenAI horizontal)
}

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
        await this.logUsage(out, input.feature, input.orgId, null, input.creative)
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
        await this.logUsage(failOut, input.feature, input.orgId, errorMessage, input.creative)
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
    creative?:     { productId: string; operation: string },
  ): Promise<void> {
    try {
      await supabaseAdmin.from('ai_usage_log').insert({
        organization_id:     orgId,
        provider:            out.provider,
        model:               out.model,
        feature,
        tokens_input:        out.inputTokens,
        tokens_output:       out.outputTokens,
        tokens_total:        out.inputTokens + out.outputTokens,
        cost_usd:            out.costUsd,
        latency_ms:          out.latencyMs,
        fallback_used:       out.fallbackUsed,
        error_message:       errorMessage,         // AI-ABS-2 Bug 4: NULL em sucesso, mensagem em falha
        creative_product_id: creative?.productId ?? null,
        creative_operation:  creative?.operation  ?? null,
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

  // ════════════════════════════════════════════════════════════════════════
  // F6 — Vision (Anthropic-only nesta sprint)
  // ════════════════════════════════════════════════════════════════════════

  /** Analisa uma imagem via Vision (Anthropic Sonnet 4.6). Mesma estrutura
   * de generateText (resolve config → call → log) mas envia content blocks
   * com image+text. URL pública preferida; base64 aceito como fallback.
   *
   * Sem fallback OpenAI nesta sprint — feature key creative_vision tem
   * fallback=null. Quando OpenAI vision for adicionado, basta plugar aqui. */
  async analyzeImage(input: {
    orgId:         string
    feature:       FeatureKey
    imageUrl?:     string
    imageBase64?:  string
    imageMimeType?: string
    systemPrompt?: string
    userPrompt:    string
    maxTokens?:    number
    jsonMode?:     boolean
    creative?:     { productId: string; operation: string }
  }): Promise<GenerateTextOutput> {
    const t0 = Date.now()
    if (!input.userPrompt || input.userPrompt.trim().length === 0) {
      throw new BadRequestException('userPrompt obrigatório')
    }
    if (!input.imageUrl && !input.imageBase64) {
      throw new BadRequestException('imageUrl ou imageBase64 obrigatório')
    }

    const config = await this.resolveConfig({ orgId: input.orgId, feature: input.feature, userPrompt: input.userPrompt })
    if (config.primary.provider !== 'anthropic') {
      throw new BadRequestException(`Vision suportado apenas via anthropic — feature ${input.feature} configurada com ${config.primary.provider}`)
    }

    let out:           GenerateTextOutput | null = null
    let errorMessage:  string | null              = null
    try {
      const result = await this.callAnthropicVision({
        orgId:        input.orgId,
        model:        config.primary.model,
        systemPrompt: input.systemPrompt,
        userPrompt:   input.jsonMode
          ? `${input.userPrompt}\n\nResponda APENAS com JSON válido, sem markdown.`
          : input.userPrompt,
        imageUrl:     input.imageUrl,
        imageBase64:  input.imageBase64,
        imageMime:    input.imageMimeType ?? 'image/jpeg',
        maxTokens:    input.maxTokens ?? 1500,
      })
      out = this.finalize(config.primary, result, t0, false)
      return out
    } catch (e) {
      errorMessage = `${config.primary.provider}/${config.primary.model}: ${this.errorStatus(e)}`
      throw e
    } finally {
      if (out) {
        await this.logUsage(out, input.feature, input.orgId, null, input.creative)
      } else {
        const failOut: GenerateTextOutput = {
          text:         '',
          provider:     config.primary.provider,
          model:        config.primary.model,
          inputTokens:  0,
          outputTokens: 0,
          costUsd:      0,
          latencyMs:    Date.now() - t0,
          fallbackUsed: false,
        }
        await this.logUsage(failOut, input.feature, input.orgId, errorMessage, input.creative)
      }
    }
  }

  private async callAnthropicVision(args: {
    orgId:        string
    model:        string
    systemPrompt?: string
    userPrompt:   string
    imageUrl?:    string
    imageBase64?: string
    imageMime:    string
    maxTokens:    number
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const keyName = 'ANTHROPIC_API_KEY'
    const apiKey = await this.credentials.getDecryptedKey(args.orgId, 'anthropic', keyName).catch(() => null)
      ?? await this.credentials.getDecryptedKey(null, 'anthropic', keyName).catch(() => null)
    if (!apiKey) throw new BadRequestException(`${keyName} não configurada`)

    const imageBlock = args.imageUrl
      ? { type: 'image', source: { type: 'url', url: args.imageUrl } }
      : { type: 'image', source: { type: 'base64', media_type: args.imageMime, data: args.imageBase64 } }

    const body: Record<string, unknown> = {
      model: args.model,
      max_tokens: args.maxTokens,
      messages: [{
        role: 'user',
        content: [imageBlock, { type: 'text', text: args.userPrompt }],
      }],
    }
    if (args.systemPrompt) body.system = args.systemPrompt

    const res = await axios.post<{
      content: Array<{ type: string; text?: string }>
      usage:   { input_tokens: number; output_tokens: number }
    }>(ANTHROPIC_URL, body, {
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 90_000, // Vision pode demorar mais que texto puro
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

  // ════════════════════════════════════════════════════════════════════════
  // F5-2 — Image generation (gpt-image-1 + Flux stub)
  // ════════════════════════════════════════════════════════════════════════

  /** Gera N variações de imagem. gpt-image-1 não suporta n>1 nativo, então
   * disparamos N chamadas em paralelo. Loga em ai_usage_log com tokens=0
   * e cost_usd = N * perImage. Sem fallback nesta sprint (feature
   * campaign_card.fallback=null). */
  async generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
    const t0 = Date.now()
    if (!input.prompt || input.prompt.trim().length === 0) {
      throw new BadRequestException('prompt obrigatório')
    }
    const n = Math.max(1, Math.min(6, input.n ?? 1))

    const config = await this.resolveConfig({ orgId: input.orgId, feature: input.feature, userPrompt: input.prompt, override: input.override })
    let errorMessage: string | null = null
    let result: GenerateImageOutput | null = null

    try {
      if (config.primary.provider === 'flux' as Provider || config.primary.model.startsWith('flux')) {
        // Flux stub (sprint F5-3 implementa de verdade)
        throw new HttpException(
          'Flux ainda não implementado — sprint F5-3. Use openai/gpt-image-1 enquanto isso.',
          HttpStatus.NOT_IMPLEMENTED,
        )
      }
      if (config.primary.provider === 'openai') {
        result = await this.callOpenAIImage({
          model:           config.primary.model,
          orgId:           input.orgId,
          prompt:          input.prompt,
          sourceImageUrl:  input.sourceImageUrl,
          format:          input.format,
          customSize:      input.customSize,
          n,
          t0,
        })
        return result
      }
      throw new BadRequestException(`Provider ${config.primary.provider} não suporta geração de imagem`)
    } catch (e) {
      errorMessage = `${config.primary.provider}/${config.primary.model}: ${this.errorStatus(e)}`
      throw e
    } finally {
      // Log SEMPRE (AI-ABS-2 pattern)
      const finalOut: GenerateImageOutput = result ?? {
        images:       [],
        provider:     config.primary.provider,
        model:        config.primary.model,
        costUsd:      0,
        latencyMs:    Date.now() - t0,
        fallbackUsed: false,
      }
      await this.logImageUsage(finalOut, input.feature, input.orgId, n, !!input.sourceImageUrl, input.format, errorMessage, input.creative)
    }
  }

  private async callOpenAIImage(args: {
    model:           string
    orgId:           string
    prompt:          string
    sourceImageUrl?: string
    format:          ImageFormat
    customSize?:     { width: number; height: number }
    n:               number
    t0:              number
  }): Promise<GenerateImageOutput> {
    const keyName = 'OPENAI_API_KEY'
    const key = await this.credentials.getDecryptedKey(args.orgId, 'openai', keyName).catch(() => null)
      ?? await this.credentials.getDecryptedKey(null, 'openai', keyName).catch(() => null)
    if (!key) throw new BadRequestException(`${keyName} não configurada`)

    const size = args.format === 'custom'
      ? `${args.customSize?.width ?? 1024}x${args.customSize?.height ?? 1024}`
      : FORMAT_SIZE[args.format]

    // gpt-image-1 não aceita n>1 — paralelizamos
    const callOne = async (): Promise<{ url?: string; b64?: string }> => {
      if (args.sourceImageUrl) {
        // Modo edit: precisa download da source primeiro
        const imgRes = await axios.get<ArrayBuffer>(args.sourceImageUrl, {
          responseType: 'arraybuffer', timeout: 30_000,
        })
        const form = new FormData()
        form.append('model',  args.model)
        form.append('prompt', args.prompt.slice(0, 32_000))
        form.append('size',   size)
        form.append('image',  Buffer.from(imgRes.data), { filename: 'source.png', contentType: 'image/png' })
        const res = await axios.post<{ data: Array<{ url?: string; b64_json?: string }> }>(
          OPENAI_IMG_EDT, form,
          {
            headers: { 'Authorization': `Bearer ${key}`, ...form.getHeaders() },
            timeout: 90_000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          },
        )
        const d0 = res.data.data?.[0] ?? {}
        return { url: d0.url, b64: d0.b64_json }
      }

      const res = await axios.post<{ data: Array<{ url?: string; b64_json?: string }> }>(
        OPENAI_IMG_GEN,
        { model: args.model, prompt: args.prompt.slice(0, 32_000), size, n: 1 },
        {
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: 90_000,
        },
      )
      const d0 = res.data.data?.[0] ?? {}
      return { url: d0.url, b64: d0.b64_json }
    }

    const settled = await Promise.allSettled(Array.from({ length: args.n }, () => callOne()))
    const images = settled
      .filter((r): r is PromiseFulfilledResult<{ url?: string; b64?: string }> => r.status === 'fulfilled')
      .map(r => r.value)
    if (images.length === 0) {
      const reason = (settled[0] as PromiseRejectedResult | undefined)?.reason
      throw reason ?? new HttpException('OpenAI image gen falhou em todas as N tentativas', HttpStatus.BAD_GATEWAY)
    }

    const perImage = IMAGE_PRICING[args.model] ?? 0
    return {
      images,
      provider:     'openai',
      model:        args.model,
      costUsd:      Math.round(images.length * perImage * 1_000_000) / 1_000_000,
      latencyMs:    Date.now() - args.t0,
      fallbackUsed: false,
    }
  }

  // TODO sprint futura — implementar quando houver conta Flux ativa pra teste real.
  // private async callFluxImage(...) — POST https://api.bfl.ai/v1/flux-pro
  //   + polling /v1/get_result. Mantido fora pra evitar ship sem teste.

  private async logImageUsage(
    out:           GenerateImageOutput,
    feature:       FeatureKey,
    orgId:         string,
    n:             number,
    hasSource:     boolean,
    format:        ImageFormat,
    errorMessage:  string | null,
    creative?:     { productId: string; imageId?: string; operation: string },
  ): Promise<void> {
    try {
      await supabaseAdmin.from('ai_usage_log').insert({
        organization_id:     orgId,
        provider:            out.provider,
        model:               out.model,
        feature,
        tokens_input:        0,
        tokens_output:       0,
        tokens_total:        0,
        cost_usd:            out.costUsd,
        latency_ms:          out.latencyMs,
        fallback_used:       false,
        error_message:       errorMessage,
        creative_product_id: creative?.productId ?? null,
        creative_image_id:   creative?.imageId   ?? null,
        creative_operation:  creative?.operation ?? null,
        // metadata seria ideal mas a coluna não existe; serializa em error_message
        // quando útil pra debug. Schema simples por ora.
      })
      // Log estruturado pra Railway (n + format + source pra observabilidade)
      this.logger.log(`[llm.image] org=${orgId} provider=${out.provider} model=${out.model} n=${n} format=${format} source=${hasSource} cost=$${out.costUsd}`)
    } catch (e) {
      this.logger.warn(`[llm.logImageUsage] insert falhou: ${(e as Error).message}`)
    }
  }
}
