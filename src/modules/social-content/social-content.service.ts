import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'
import {
  buildSocialContentPrompt,
  buildRegeneratePrompt,
} from './social-content.prompt'
import {
  type SocialChannel,
  type SocialContent,
  type SocialContentStatus,
  SOCIAL_CHANNELS,
} from './social-content.types'

interface GenerateInput {
  orgId:    string
  userId:   string
  productId: string
  channels:  SocialChannel[]
  style?:    string
}

interface GenerateBatchInput {
  orgId:      string
  userId:     string
  productIds: string[]
  channels:   SocialChannel[]
  style?:     string
}

interface ListInput {
  orgId:     string
  channel?:  SocialChannel
  productId?: string
  status?:   SocialContentStatus
  limit?:    number
  offset?:   number
}

@Injectable()
export class SocialContentService {
  private readonly logger = new Logger(SocialContentService.name)

  constructor(private readonly llm: LlmService) {}

  // ─────────────────────────────────────────────────────────────────
  // GERAÇÃO
  // ─────────────────────────────────────────────────────────────────

  /** Gera conteúdo pra 1 produto em N canais (1 chamada Sonnet, fan-out
   *  pra N rows em social_content). */
  async generateForProduct(input: GenerateInput): Promise<{
    items:    SocialContent[]
    cost_usd: number
  }> {
    if (!input.channels?.length) {
      throw new BadRequestException('channels obrigatório (≥1)')
    }
    const invalid = input.channels.filter(c => !SOCIAL_CHANNELS.includes(c))
    if (invalid.length > 0) {
      throw new BadRequestException(`channels inválidos: ${invalid.join(', ')}`)
    }

    const product = await this.fetchProduct(input.productId, input.orgId)

    const { systemPrompt, userPrompt } = buildSocialContentPrompt(
      product,
      input.channels,
      input.style,
    )

    const out = await this.llm.generateText({
      orgId:        input.orgId,
      feature:      'social_content_gen',
      systemPrompt,
      userPrompt,
      maxTokens:    2400,
      temperature:  0.6,
      jsonMode:     true,
    })

    let parsed: { channels?: Record<string, unknown> }
    try {
      parsed = JSON.parse(out.text)
    } catch (e) {
      this.logger.warn(`[social-content] parse JSON falhou: ${(e as Error).message}`)
      throw new BadRequestException('IA retornou JSON inválido — tente novamente')
    }

    const channelsOut = parsed.channels ?? {}
    const rows: Array<Partial<SocialContent>> = []
    for (const channel of input.channels) {
      const content = channelsOut[channel]
      if (!content) {
        this.logger.warn(`[social-content] canal ${channel} ausente no output`)
        continue
      }
      rows.push({
        organization_id:     input.orgId,
        product_id:          input.productId,
        user_id:             input.userId,
        channel,
        content:             content as Record<string, unknown>,
        status:              'draft' as SocialContentStatus,
        generation_metadata: {
          provider:   'anthropic',
          model:      'claude-sonnet-4-6',
          latency_ms: 0,
          cost_usd:   out.costUsd,
          style:      input.style ?? null,
        },
      })
    }

    if (rows.length === 0) {
      throw new BadRequestException('IA não retornou conteúdo pra nenhum canal solicitado')
    }

    const { data, error } = await supabaseAdmin
      .from('social_content')
      .insert(rows)
      .select('*')

    if (error) {
      this.logger.error(`[social-content] insert falhou: ${error.message}`)
      throw new BadRequestException(`Erro ao salvar: ${error.message}`)
    }

    return { items: (data ?? []) as SocialContent[], cost_usd: out.costUsd }
  }

  /** Gera conteúdo pra N produtos em N canais. Cada produto = 1 chamada
   *  Sonnet (paralelizado em batches de 3 pra não estourar rate limit). */
  async generateBatch(input: GenerateBatchInput): Promise<{
    generated: number
    failed:    number
    cost_usd:  number
    items:     SocialContent[]
  }> {
    if (!input.productIds?.length) {
      throw new BadRequestException('productIds obrigatório (≥1)')
    }
    if (input.productIds.length > 50) {
      throw new BadRequestException('máximo 50 produtos por batch')
    }

    let totalCost = 0
    let failed    = 0
    const allItems: SocialContent[] = []

    // Paraleliza em batches de 3
    const batchSize = 3
    for (let i = 0; i < input.productIds.length; i += batchSize) {
      const slice = input.productIds.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        slice.map(productId =>
          this.generateForProduct({
            orgId:    input.orgId,
            userId:   input.userId,
            productId,
            channels: input.channels,
            style:    input.style,
          }),
        ),
      )
      for (const r of results) {
        if (r.status === 'fulfilled') {
          totalCost += r.value.cost_usd
          allItems.push(...r.value.items)
        } else {
          failed++
          this.logger.warn(`[social-content] batch item falhou: ${r.reason}`)
        }
      }
    }

    return {
      generated: allItems.length,
      failed,
      cost_usd:  totalCost,
      items:     allItems,
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // LISTAGEM / CRUD
  // ─────────────────────────────────────────────────────────────────

  async list(input: ListInput): Promise<{ items: SocialContent[]; total: number }> {
    const limit  = Math.min(input.limit  ?? 50, 200)
    const offset = Math.max(input.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('social_content')
      .select('*', { count: 'exact' })
      .eq('organization_id', input.orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (input.channel)   q = q.eq('channel',    input.channel)
    if (input.productId) q = q.eq('product_id', input.productId)
    if (input.status)    q = q.eq('status',     input.status)

    const { data, error, count } = await q
    if (error) {
      throw new BadRequestException(`Erro ao listar: ${error.message}`)
    }
    return { items: (data ?? []) as SocialContent[], total: count ?? 0 }
  }

  async get(id: string, orgId: string): Promise<SocialContent> {
    const { data, error } = await supabaseAdmin
      .from('social_content')
      .select('*')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error)  throw new BadRequestException(`Erro: ${error.message}`)
    if (!data)  throw new NotFoundException('Conteúdo não encontrado')
    return data as SocialContent
  }

  async update(id: string, orgId: string, patch: Partial<SocialContent>): Promise<SocialContent> {
    // Whitelist de campos editáveis
    const allowed: (keyof SocialContent)[] = [
      'content', 'creative_image_ids', 'creative_video_id',
      'scheduled_at', 'published_at', 'published_url',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) {
      if (k in patch) safe[k] = patch[k]
    }
    if (Object.keys(safe).length === 0) {
      throw new BadRequestException('nada pra atualizar')
    }

    const { data, error } = await supabaseAdmin
      .from('social_content')
      .update(safe)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Conteúdo não encontrado')
    return data as SocialContent
  }

  /** Regenera o conteúdo de 1 row específica com instrução adicional.
   *  Cria NOVA row apontando pra parent (versionamento), não sobrescreve. */
  async regenerate(id: string, orgId: string, instruction: string): Promise<{
    item:     SocialContent
    cost_usd: number
  }> {
    const previous = await this.get(id, orgId)
    const product  = await this.fetchProduct(previous.product_id, orgId)

    const { systemPrompt, userPrompt } = buildRegeneratePrompt(
      product,
      previous.channel,
      previous.content,
      instruction,
    )

    const out = await this.llm.generateText({
      orgId:        orgId,
      feature:      'social_content_gen',
      systemPrompt,
      userPrompt,
      maxTokens:    1200,
      temperature:  0.7,
      jsonMode:     true,
    })

    let newContent: Record<string, unknown>
    try {
      newContent = JSON.parse(out.text) as Record<string, unknown>
    } catch {
      throw new BadRequestException('IA retornou JSON inválido — tente novamente')
    }

    const { data, error } = await supabaseAdmin
      .from('social_content')
      .insert({
        organization_id: orgId,
        product_id:      previous.product_id,
        user_id:         previous.user_id,
        channel:         previous.channel,
        content:         newContent,
        status:          'draft',
        version:         previous.version + 1,
        parent_id:       previous.id,
        generation_metadata: {
          provider:    'anthropic',
          model:       'claude-sonnet-4-6',
          cost_usd:    out.costUsd,
          instruction,
          regen_of:    previous.id,
        },
      })
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new BadRequestException('falha ao salvar regen')
    return { item: data as SocialContent, cost_usd: out.costUsd }
  }

  // ─────────────────────────────────────────────────────────────────
  // STATUS LIFECYCLE
  // ─────────────────────────────────────────────────────────────────

  async approve(id: string, orgId: string): Promise<SocialContent> {
    return this.transition(id, orgId, 'approved', ['draft'])
  }

  async schedule(id: string, orgId: string, scheduledAt: string): Promise<SocialContent> {
    if (!scheduledAt) throw new BadRequestException('scheduled_at obrigatório')
    const when = new Date(scheduledAt)
    if (isNaN(when.getTime())) {
      throw new BadRequestException('scheduled_at inválido (use ISO 8601)')
    }
    if (when.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('scheduled_at não pode ser no passado')
    }

    const { data, error } = await supabaseAdmin
      .from('social_content')
      .update({ status: 'scheduled', scheduled_at: when.toISOString() })
      .eq('id', id)
      .eq('organization_id', orgId)
      .in('status', ['draft', 'approved'])
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Conteúdo não encontrado ou já publicado')
    return data as SocialContent
  }

  async archive(id: string, orgId: string): Promise<SocialContent> {
    const { data, error } = await supabaseAdmin
      .from('social_content')
      .update({ status: 'archived' })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Conteúdo não encontrado')
    return data as SocialContent
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────

  private async transition(
    id: string,
    orgId: string,
    to: SocialContentStatus,
    fromAllowed: SocialContentStatus[],
  ): Promise<SocialContent> {
    const { data, error } = await supabaseAdmin
      .from('social_content')
      .update({ status: to })
      .eq('id', id)
      .eq('organization_id', orgId)
      .in('status', fromAllowed)
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) {
      throw new BadRequestException(
        `Transição inválida: só é possível ir pra ${to} a partir de [${fromAllowed.join(',')}]`,
      )
    }
    return data as SocialContent
  }

  private async fetchProduct(productId: string, orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(`
        id, organization_id, name, brand, category, price,
        ai_short_description, description, differentials, bullets,
        ai_target_audience, tags, ai_analysis
      `)
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro ao buscar produto: ${error.message}`)
    if (!data) throw new NotFoundException('Produto não encontrado')
    return data as {
      id:                 string
      name:               string
      brand:              string | null
      category:           string | null
      price:              number | null
      ai_short_description: string | null
      description:          string | null
      differentials:        string[] | null
      bullets:              string[] | null
      ai_target_audience:   string | null
      tags:               string[] | null
      ai_analysis:        Record<string, unknown> | null
    }
  }
}
