import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { ActiveBridgeClient, type BroadcastSegment } from '../active-bridge/active-bridge.client'
import { supabaseAdmin } from '../../common/supabase'
import {
  buildSocialContentPrompt,
  buildRegeneratePrompt,
} from './social-content.prompt'
import {
  type SocialChannel,
  type SocialContent,
  type SocialContentStatus,
  type SocialImageFormat,
  type SocialPostImage,
  SOCIAL_CHANNELS,
  SOCIAL_IMAGE_FORMATS,
} from './social-content.types'
import { randomUUID } from 'node:crypto'

/** Força https:// (fotos do ML vêm http://; provedores de imagem rejeitam http). */
function toHttps(url: string): string {
  const u = (url ?? '').trim()
  if (u.startsWith('http://')) return 'https://' + u.slice('http://'.length)
  if (u.startsWith('//'))      return 'https:' + u
  return u
}

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

  constructor(
    private readonly llm:    LlmService,
    private readonly bridge: ActiveBridgeClient,
  ) {}

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
  // GERAÇÃO VISUAL (e-Click Social AI — SV1)
  // ─────────────────────────────────────────────────────────────────

  /** Gera N imagens de post social a partir de um produto. Usa a foto do
   *  produto como REFERÊNCIA (Gemini multi-image edit, feature creative_image)
   *  pra preservar o produto real numa cena social estilizada. Cada imagem é
   *  persistida no bucket público + tabela social_post_images. */
  async generatePostImage(input: {
    orgId:       string
    userId:      string
    productId:   string
    format:      SocialImageFormat
    style?:      string
    n?:          number
    extraPrompt?: string
  }): Promise<{ images: SocialPostImage[]; cost_usd: number }> {
    if (!SOCIAL_IMAGE_FORMATS.includes(input.format)) {
      throw new BadRequestException(`format inválido: ${input.format}`)
    }
    const n = Math.max(1, Math.min(4, input.n ?? 2))

    const product = await this.fetchProductForImage(input.productId, input.orgId)
    const refPhoto = product.photo_urls?.find(u => !!u)
    if (!refPhoto) {
      throw new BadRequestException('Produto sem foto — adicione ao menos 1 imagem antes de gerar')
    }

    const prompt = this.buildImagePrompt(product, input.format, input.style, input.extraPrompt)
    // feed=square(1:1), story=story(9:16), wide=wide(16:9)
    const imgFormat = input.format === 'feed' ? 'square' : input.format === 'story' ? 'story' : 'wide'

    const out = await this.llm.generateImage({
      orgId:           input.orgId,
      feature:         'creative_image',
      prompt,
      sourceImageUrls: [toHttps(refPhoto)],
      format:          imgFormat as 'square' | 'story' | 'wide',
      n,
    })

    if (!out.images?.length) {
      throw new BadRequestException('IA não retornou imagem — tente novamente')
    }

    // Upload de cada variação pro bucket + persiste
    const perImageCost = out.images.length > 0 ? out.costUsd / out.images.length : 0
    const rows: Array<Partial<SocialPostImage>> = []
    for (const img of out.images) {
      const bytes = await this.imageToBuffer(img)
      if (!bytes) continue
      const path = `${input.orgId}/social/${randomUUID()}.png`
      const publicUrl = await this.uploadToBucket(path, bytes)
      rows.push({
        organization_id: input.orgId,
        product_id:      input.productId,
        user_id:         input.userId,
        format:          input.format,
        style:           input.style ?? null,
        prompt,
        image_url:       publicUrl,
        storage_path:    path,
        provider:        out.provider,
        model:           out.model,
        cost_usd:        perImageCost,
      })
    }
    if (rows.length === 0) {
      throw new BadRequestException('Falha ao processar as imagens geradas')
    }

    const { data, error } = await supabaseAdmin
      .from('social_post_images')
      .insert(rows)
      .select('*')
    if (error) {
      this.logger.error(`[social-content] insert social_post_images falhou: ${error.message}`)
      throw new BadRequestException(`Erro ao salvar imagens: ${error.message}`)
    }
    return { images: (data ?? []) as SocialPostImage[], cost_usd: out.costUsd }
  }

  async listPostImages(orgId: string, productId?: string, limit = 60): Promise<SocialPostImage[]> {
    let q = supabaseAdmin
      .from('social_post_images')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 200))
    if (productId) q = q.eq('product_id', productId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro ao listar: ${error.message}`)
    return (data ?? []) as SocialPostImage[]
  }

  async deletePostImage(id: string, orgId: string): Promise<{ ok: true }> {
    const { data } = await supabaseAdmin
      .from('social_post_images')
      .select('storage_path')
      .eq('id', id).eq('organization_id', orgId)
      .maybeSingle()
    await supabaseAdmin.from('social_post_images').delete().eq('id', id).eq('organization_id', orgId)
    const path = (data as { storage_path?: string } | null)?.storage_path
    if (path) {
      await supabaseAdmin.storage.from('storefront-assets').remove([path]).catch(() => {})
    }
    return { ok: true }
  }

  /** Monta o prompt de imagem a partir do produto + estilo + formato. */
  private buildImagePrompt(
    product: { name: string; brand: string | null; category: string | null },
    format: SocialImageFormat,
    style?: string,
    extra?: string,
  ): string {
    const styleHint: Record<string, string> = {
      lifestyle: 'em um ambiente real de uso, contexto lifestyle aspiracional, luz natural suave',
      studio:    'em fundo de estúdio limpo e elegante, iluminação profissional de produto',
      promo:     'com clima promocional energético, destaque visual forte, cores chamativas',
      seasonal:  'com ambientação sazonal sutil e elegante',
      minimal:   'composição minimalista, muito espaço negativo, estética clean premium',
      vibrant:   'cores vibrantes e saturadas, composição moderna e energética',
    }
    const formatHint: Record<SocialImageFormat, string> = {
      feed:  'enquadramento quadrado (1:1) para feed do Instagram',
      story: 'enquadramento vertical (9:16) para Story/Reels, produto centralizado com respiro no topo e base',
      wide:  'enquadramento horizontal (16:9)',
    }
    const sty = style && styleHint[style] ? styleHint[style] : styleHint.lifestyle
    const parts = [
      `Crie uma imagem de post para redes sociais do produto "${product.name}"`,
      product.brand ? `da marca ${product.brand}` : '',
      product.category ? `(categoria: ${product.category})` : '',
      `${sty}.`,
      `${formatHint[format]}.`,
      'PRESERVE FIELMENTE o produto da imagem de referência — mesma forma, cor e detalhes; apenas componha a cena ao redor.',
      'Sem texto sobreposto, sem marca dágua, sem logos inventados. Resultado fotográfico realista, alta qualidade, pronto pra publicar.',
      extra?.trim() ? `Instrução adicional: ${extra.trim()}` : '',
    ]
    return parts.filter(Boolean).join(' ')
  }

  /** Converte a saída do generateImage (b64 ou url) em Buffer. */
  private async imageToBuffer(img: { url?: string; b64?: string }): Promise<Buffer | null> {
    try {
      if (img.b64) return Buffer.from(img.b64, 'base64')
      if (img.url) {
        const res = await fetch(img.url)
        if (!res.ok) return null
        return Buffer.from(await res.arrayBuffer())
      }
    } catch (e) {
      this.logger.warn(`[social-content] imageToBuffer falhou: ${(e as Error).message}`)
    }
    return null
  }

  /** Upload pro bucket público storefront-assets, retorna URL pública. */
  private async uploadToBucket(path: string, bytes: Buffer): Promise<string> {
    const { error } = await supabaseAdmin.storage
      .from('storefront-assets')
      .upload(path, bytes, { contentType: 'image/png', upsert: true })
    if (error) throw new BadRequestException(`Erro no upload: ${error.message}`)
    return supabaseAdmin.storage.from('storefront-assets').getPublicUrl(path).data.publicUrl
  }

  private async fetchProductForImage(productId: string, orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, name, brand, category, photo_urls')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro ao buscar produto: ${error.message}`)
    if (!data) throw new NotFoundException('Produto não encontrado')
    return data as { id: string; name: string; brand: string | null; category: string | null; photo_urls: string[] | null }
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

  // ─────────────────────────────────────────────────────────────────
  // PUBLISH (dispatch real pra canal — bridge SaaS↔Active)
  // ─────────────────────────────────────────────────────────────────

  /** Publica peça no canal apropriado. Hoje só `whatsapp_broadcast` está
   *  conectado (via Active bridge). Outros canais ainda dependem de
   *  integrações específicas (IG Graph publish, TikTok, email, etc.). */
  async publishContent(id: string, orgId: string): Promise<{
    item:    SocialContent
    result:  Record<string, unknown>
  }> {
    const item = await this.get(id, orgId)
    if (item.status === 'published') {
      throw new BadRequestException('Peça já está publicada')
    }
    if (item.status === 'archived') {
      throw new BadRequestException('Peça arquivada não pode ser publicada')
    }

    // Roteamento por canal
    if (item.channel === 'whatsapp_broadcast') {
      return this.publishWhatsAppBroadcast(item)
    }

    throw new BadRequestException(
      `Publicação automática para canal '${item.channel}' ainda não disponível. ` +
      `Atualmente só whatsapp_broadcast está conectado via bridge Active.`,
    )
  }

  private async publishWhatsAppBroadcast(item: SocialContent): Promise<{
    item:   SocialContent
    result: Record<string, unknown>
  }> {
    const c = item.content as {
      message?:        string
      include_image?:  boolean
      include_link?:   boolean
      target_segment?: string
    }
    if (!c.message?.trim()) {
      throw new BadRequestException('Conteúdo sem campo `message` — não pode publicar')
    }
    const segment: BroadcastSegment =
      c.target_segment === 'compradores' || c.target_segment === 'interessados' || c.target_segment === 'inativos'
        ? c.target_segment
        : 'todos'

    // Resolve image_url e link_url best-effort
    let imageUrl: string | undefined
    let linkUrl:  string | undefined
    if (c.include_image || c.include_link) {
      const { data: prod } = await supabaseAdmin
        .from('products')
        .select('id, photo_urls, ml_permalink, landing_page_enabled, landing_page_slug, organization_id')
        .eq('id', item.product_id)
        .eq('organization_id', item.organization_id)
        .maybeSingle()
      if (prod) {
        const p = prod as {
          photo_urls: string[] | null
          ml_permalink: string | null
          landing_page_enabled: boolean | null
          landing_page_slug: string | null
        }
        if (c.include_image) imageUrl = p.photo_urls?.[0] ?? undefined
        if (c.include_link)  linkUrl  = p.landing_page_enabled && p.landing_page_slug
          ? `${process.env.FRONTEND_URL ?? 'https://eclick.app.br'}/loja/${item.organization_id}/${p.landing_page_slug}`
          : (p.ml_permalink ?? undefined)
      }
    }

    const result = await this.bridge.sendBroadcast({
      organization_id:   item.organization_id,
      message:           c.message,
      target_segment:    segment,
      include_image:     Boolean(c.include_image),
      image_url:         imageUrl,
      include_link:      Boolean(c.include_link),
      link_url:          linkUrl,
      source_content_id: item.id,
    })

    // Marca como publicado
    const { data: updated } = await supabaseAdmin
      .from('social_content')
      .update({
        status:        'published' as SocialContentStatus,
        published_at:  new Date().toISOString(),
        published_url: null,  // WhatsApp não tem URL pública
      })
      .eq('id', item.id)
      .eq('organization_id', item.organization_id)
      .select('*')
      .maybeSingle()

    return {
      item:   (updated ?? item) as SocialContent,
      result: result as Record<string, unknown>,
    }
  }

  /** Worker helper — lista peças com status='scheduled' cujo scheduled_at
   *  já passou, limitado por canais publicáveis hoje. */
  async listDueScheduled(limit = 20): Promise<SocialContent[]> {
    const { data, error } = await supabaseAdmin
      .from('social_content')
      .select('*')
      .eq('status', 'scheduled')
      .eq('channel', 'whatsapp_broadcast')   // só canal publicável hoje
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(limit)
    if (error) {
      this.logger.warn(`[social-content] listDueScheduled: ${error.message}`)
      return []
    }
    return (data ?? []) as SocialContent[]
  }
}
