import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import { BANNER_STYLES, BANNER_STYLES_MAP, resolveBannerPrompt, type BannerProductInfo, type BannerThemeInfo, type BannerStyle, type BannerFormat } from './banner-styles'
import type { BannerProductSummary, BannerGenerateInput, BannerGenerateOutput } from './banner-generator.types'

const BUCKET = 'storefront-assets'

@Injectable()
export class BannerGeneratorService {
  private readonly logger = new Logger(BannerGeneratorService.name)

  constructor(private readonly llm: LlmService) {}

  // ─ Catalog (publico ao cliente — sem auth necessaria) ────────

  listStyles(): BannerStyle[] {
    return BANNER_STYLES
  }

  // ─ Produtos da loja (com info rica pra resolver prompt) ──────

  async listProducts(orgId: string, opts: { limit?: number; q?: string } = {}): Promise<BannerProductSummary[]> {
    const limit = Math.min(opts.limit ?? 50, 100)
    let q = supabaseAdmin
      .from('products')
      .select('id, name, category, brand, price, photo_urls, ai_short_description, description, storefront_visible')
      .eq('organization_id', orgId)
      .eq('storefront_visible', true)
      .order('updated_at', { ascending: false })
      .limit(limit)
    if (opts.q?.trim()) {
      q = q.ilike('name', `%${opts.q.trim()}%`)
    }
    const { data, error } = await q
    if (error) {
      this.logger.error(`[banner-gen] list products org=${orgId} ${error.message}`)
      throw new BadRequestException('Falha ao carregar produtos.')
    }
    return (data ?? []).map(p => {
      const row = p as {
        id: string; name: string; category: string | null; brand: string | null
        price: number
        photo_urls: string[] | null
        ai_short_description: string | null; description: string | null
      }
      return {
        id:                row.id,
        name:              row.name,
        category:          row.category,
        brand:             row.brand,
        price:             Number(row.price ?? 0),
        sale_price:        null,  // coluna nao existe em products — promo via outra fonte (ml_promotions, etc.) — TODO
        photo_url:         row.photo_urls?.[0] ?? null,
        short_description: row.ai_short_description ?? (row.description ? row.description.slice(0, 200) : null),
      }
    })
  }

  // ─ Generate ──────────────────────────────────────────────────

  async generateBanner(orgId: string, input: BannerGenerateInput): Promise<BannerGenerateOutput> {
    const style = BANNER_STYLES_MAP[input.styleKey]
    if (!style) throw new NotFoundException(`Estilo "${input.styleKey}" nao encontrado.`)
    if (!input.productIds?.length) throw new BadRequestException('Selecione pelo menos 1 produto.')
    if (input.productIds.length > style.productRange.max) {
      throw new BadRequestException(`Este estilo aceita no máximo ${style.productRange.max} produto(s).`)
    }
    if (input.productIds.length < style.productRange.min) {
      throw new BadRequestException(`Este estilo exige no mínimo ${style.productRange.min} produto(s).`)
    }

    // 1. Busca dados ricos dos produtos selecionados
    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select('id, name, category, brand, price, photo_urls, ai_short_description, description')
      .eq('organization_id', orgId)
      .in('id', input.productIds)
    if (error) throw new BadRequestException(error.message)
    if (!products?.length) throw new BadRequestException('Produtos não encontrados.')

    const productsInfo: BannerProductInfo[] = products.map(p => {
      const row = p as {
        id: string; name: string; category: string | null; brand: string | null
        price: number
        photo_urls: string[] | null
        ai_short_description: string | null; description: string | null
      }
      return {
        id:                row.id,
        name:              row.name,
        category:          row.category,
        brand:             row.brand,
        price:             Number(row.price ?? 0),
        sale_price:        null,  // sem coluna de promo direta em products (TODO: enriquecer via ml_promotions)
        photo_url:         row.photo_urls?.[0] ?? null,
        short_description: row.ai_short_description ?? (row.description ? row.description.slice(0, 200) : null),
      }
    })

    // 2. Theme info (cores + nome) do store_config
    const theme = await this.loadThemeInfo(orgId)

    // 3. Resolve prompt
    const finalPrompt = input.customPrompt?.trim()
      ? input.customPrompt
      : resolveBannerPrompt(style.promptTemplate, productsInfo, theme, input.customAdditions)

    // 4. Source images (fotos dos produtos pra Gemini usar como referencia)
    const sourceUrls = productsInfo
      .map(p => p.photo_url)
      .filter((u): u is string => !!u && u.startsWith('http'))
      .slice(0, 4)  // limite pra evitar prompts gigantes

    // Aceita formats[] (preferencial) ou format (legado).
    const formats: BannerFormat[] = input.formats && input.formats.length > 0
      ? input.formats
      : [input.format ?? style.defaultFormat]
    const variations = Math.max(1, Math.min(input.variations ?? 1, 4))

    // 5. Chama LlmService.generateImage em paralelo, 1 chamada por formato
    let outs
    try {
      outs = await Promise.all(formats.map(fmt =>
        this.llm.generateImage({
          orgId,
          feature:         'storefront_hero_image',
          prompt:          finalPrompt,
          format:          fmt,
          n:               variations,
          sourceImageUrls: sourceUrls.length > 0 ? sourceUrls : undefined,
        }).then(out => ({ fmt, out }))
      ))
    } catch (e) {
      this.logger.error(`[banner-gen] LLM falhou: ${(e as Error).message}`)
      throw new BadRequestException('A IA não conseguiu gerar o banner agora. Tente de novo em instantes.')
    }

    // 6. Upload das imagens geradas no bucket (algumas vem como base64)
    const uploaded: Array<{ url: string; format: BannerFormat }> = []
    let totalCost = 0
    let anyFallback = false
    for (const { fmt, out } of outs) {
      totalCost += out.costUsd
      if (out.fallbackUsed) anyFallback = true
      for (const img of out.images) {
        if (img.url && img.url.startsWith('http')) {
          uploaded.push({ url: img.url, format: fmt })
          continue
        }
        if (img.b64) {
          const ext = 'png'
          const path = `${orgId}/banner/${randomUUID()}.${ext}`
          const buffer = Buffer.from(img.b64, 'base64')
          const { error: upErr } = await supabaseAdmin.storage
            .from(BUCKET)
            .upload(path, buffer, { contentType: 'image/png', upsert: false })
          if (upErr) {
            this.logger.error(`[banner-gen] upload falhou: ${upErr.message}`)
            continue
          }
          const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path)
          if (pub?.publicUrl) uploaded.push({ url: pub.publicUrl, format: fmt })
        }
      }
    }
    if (!uploaded.length) {
      throw new BadRequestException('A IA gerou imagens mas o upload falhou. Tente de novo.')
    }

    this.logger.log(
      `[banner-gen] org=${orgId} style=${input.styleKey} formats=${formats.join(',')} ` +
      `total=${uploaded.length} cost=$${totalCost.toFixed(4)} fallback=${anyFallback}`,
    )

    // Persiste no histórico — 1 row por imagem gerada. Custo é dividido
    // entre as imagens (estimativa). Falha silenciosa pra não derrubar
    // a resposta caso o INSERT falhe.
    try {
      const costPerImage = uploaded.length > 0 ? totalCost / uploaded.length : 0
      const rows = uploaded.map(u => ({
        organization_id: orgId,
        image_url:       u.url,
        format:          u.format,
        style_key:       input.styleKey,
        prompt_used:     finalPrompt,
        custom_prompt:   Boolean(input.customPrompt?.trim()),
        product_ids:     input.productIds,
        cost_usd:        costPerImage,
        fallback_used:   anyFallback,
        variations:      variations,
      }))
      const { error: insErr } = await supabaseAdmin.from('generated_banners').insert(rows)
      if (insErr) this.logger.warn(`[banner-gen.persist] ${insErr.message}`)
    } catch (err) {
      this.logger.warn(`[banner-gen.persist] ${(err as Error).message}`)
    }

    return {
      images:       uploaded,
      promptUsed:   finalPrompt,
      styleKey:     input.styleKey,
      formats,
      costUsd:      totalCost,
      fallbackUsed: anyFallback,
    }
  }

  /** Lista banners gerados (histórico, mais recentes primeiro). */
  async listHistory(orgId: string, opts: { format?: string; limit?: number; offset?: number } = {}): Promise<{
    banners: Array<{
      id:            string
      image_url:     string
      format:        string
      style_key:     string | null
      prompt_used:   string | null
      custom_prompt: boolean
      product_ids:   string[]
      cost_usd:      number
      fallback_used: boolean
      created_at:    string
    }>
    total: number
  }> {
    const limit  = Math.min(opts.limit ?? 24, 100)
    const offset = Math.max(opts.offset ?? 0, 0)
    let q = supabaseAdmin
      .from('generated_banners')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (opts.format) q = q.eq('format', opts.format)
    const { data, error, count } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return {
      banners: (data ?? []) as unknown as Array<{
        id: string; image_url: string; format: string; style_key: string | null
        prompt_used: string | null; custom_prompt: boolean; product_ids: string[]
        cost_usd: number; fallback_used: boolean; created_at: string
      }>,
      total: count ?? 0,
    }
  }

  /** Remove um banner do histórico (não apaga do storage pra evitar
   *  quebrar refs externas — TODO: cleanup job que remove órfãos). */
  async deleteBanner(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('generated_banners')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  private async loadThemeInfo(orgId: string): Promise<BannerThemeInfo> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('store_name, design_v3, design')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!data) return {}
    const row = data as { store_name?: string; design_v3?: { theme?: { colors?: { primary?: string; background?: string } } } | null; design?: { theme?: { colors?: { primary?: string; background?: string } } } | null }
    const theme = row.design_v3?.theme ?? row.design?.theme
    return {
      store_name:       row.store_name,
      primary_color:    theme?.colors?.primary,
      secondary_color:  theme?.colors?.background,
    }
  }
}
