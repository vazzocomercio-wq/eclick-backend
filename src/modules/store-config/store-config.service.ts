import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import * as dns from 'node:dns/promises'
import axios from 'axios'

/** Onda 4 / A6 — Store Config (white-label). */

export interface StoreTheme {
  primary_color?:      string
  secondary_color?:    string
  accent_color?:       string
  font_heading?:       string
  font_body?:          string
  border_radius?:      string
  layout?:             'modern' | 'classic' | 'minimal'
  hero_style?:         'full_width' | 'split' | 'centered'
  product_card_style?: 'minimal' | 'detailed' | 'card'
  footer_style?:       'standard' | 'minimal' | 'rich'
}

export interface StoreConfig {
  id:                       string
  organization_id:          string
  store_name:               string
  store_slug:               string
  store_description:        string | null
  logo_url:                 string | null
  favicon_url:              string | null
  custom_domain:            string | null
  domain_verified:          boolean
  ssl_status:               'pending' | 'active' | 'failed' | 'none'
  theme:                    StoreTheme
  seo_title:                string | null
  seo_description:          string | null
  seo_keywords:             string[]
  og_image_url:             string | null
  google_analytics_id:      string | null
  meta_pixel_id:            string | null
  gtm_id:                   string | null
  currency:                 string
  language:                 string
  shipping_enabled:         boolean
  payments_enabled:         boolean
  whatsapp_widget_enabled:  boolean
  whatsapp_number:          string | null
  ai_seller_widget_enabled: boolean
  social_links:             Record<string, string>
  pages:                    Record<string, { title: string; content: string }>
  status:                   'setup' | 'active' | 'paused' | 'suspended'
  created_at:               string
  updated_at:               string
}

export const THEME_PRESETS: Record<string, StoreTheme> = {
  cyan_dark: {
    primary_color:   '#00E5FF',
    secondary_color: '#09090B',
    accent_color:    '#22C55E',
    layout:          'modern',
    hero_style:      'full_width',
    product_card_style: 'minimal',
  },
  warm_light: {
    primary_color:   '#F97316',
    secondary_color: '#FFFFFF',
    accent_color:    '#F59E0B',
    layout:          'classic',
    hero_style:      'split',
    product_card_style: 'card',
  },
  pink_modern: {
    primary_color:   '#E1306C',
    secondary_color: '#1F2937',
    accent_color:    '#A855F7',
    layout:          'modern',
    hero_style:      'centered',
    product_card_style: 'detailed',
  },
  green_minimal: {
    primary_color:   '#22C55E',
    secondary_color: '#FAFAFA',
    accent_color:    '#0EA5E9',
    layout:          'minimal',
    hero_style:      'centered',
    product_card_style: 'minimal',
  },
}

@Injectable()
export class StoreConfigService {
  private readonly logger = new Logger(StoreConfigService.name)

  async getOrCreate(orgId: string, defaults: { store_name: string; store_slug?: string }): Promise<StoreConfig> {
    const { data, error } = await supabaseAdmin
      .from('store_config').select('*')
      .eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (data) return data as StoreConfig

    const slug = (defaults.store_slug ?? defaults.store_name)
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').slice(0, 60)

    const { data: created, error: insErr } = await supabaseAdmin
      .from('store_config')
      .insert({
        organization_id: orgId,
        store_name:      defaults.store_name,
        store_slug:      `${slug}-${Math.random().toString(36).slice(2, 6)}`,
      })
      .select('*').maybeSingle()
    if (insErr || !created) throw new BadRequestException(`Erro ao criar: ${insErr?.message}`)
    return created as StoreConfig
  }

  async get(orgId: string): Promise<StoreConfig | null> {
    const { data, error } = await supabaseAdmin
      .from('store_config').select('*')
      .eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data as StoreConfig) ?? null
  }

  async update(orgId: string, patch: Partial<StoreConfig>): Promise<StoreConfig> {
    const allowed: (keyof StoreConfig)[] = [
      'store_name', 'store_slug', 'store_description',
      'logo_url', 'favicon_url',
      'custom_domain',
      'theme',
      'seo_title', 'seo_description', 'seo_keywords', 'og_image_url',
      'google_analytics_id', 'meta_pixel_id', 'gtm_id',
      'currency', 'language',
      'shipping_enabled', 'payments_enabled',
      'whatsapp_widget_enabled', 'whatsapp_number',
      'ai_seller_widget_enabled', 'social_links', 'pages',
      'status',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('nada pra atualizar')

    // Sanitiza custom_domain: remove protocolo, trailing slash, www. opcional,
    // espacos e converte pra lowercase. Aceita "https://www.dominio.com.br/"
    // e salva como "dominio.com.br" (mas mantem subdominio quando intencional
    // tipo "loja.dominio.com.br").
    if ('custom_domain' in safe && typeof safe.custom_domain === 'string') {
      const raw = (safe.custom_domain as string).trim().toLowerCase()
      if (raw === '') {
        safe.custom_domain = null
      } else {
        safe.custom_domain = raw
          .replace(/^https?:\/\//, '')   // remove protocolo
          .replace(/\/.*$/, '')          // remove path
          .replace(/^www\./, '')          // remove www. (apex preferido)
      }
    }

    // Se mudou domínio, reseta verificação
    if ('custom_domain' in patch) {
      safe.domain_verified = false
      safe.ssl_status      = 'pending'
    }

    const { data, error } = await supabaseAdmin
      .from('store_config').update(safe)
      .eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as StoreConfig
  }

  /** Verifica se o custom_domain aponta CNAME pra eclick.app.br ou subdomain
   *  configurado em STORE_DOMAIN_TARGET. Retorna verified status. */
  async verifyDomain(orgId: string): Promise<{ verified: boolean; reason?: string; expected_target?: string }> {
    const c = await this.get(orgId)
    if (!c) throw new NotFoundException('Config não encontrada')
    if (!c.custom_domain) {
      throw new BadRequestException('custom_domain não definido')
    }

    const expectedTarget = process.env.STORE_DOMAIN_TARGET ?? 'storefront.eclick.app.br'

    try {
      // 1) Caso ideal — CNAME literal aponta pra expectedTarget (DNS only/cinza)
      const records = await dns.resolveCname(c.custom_domain).catch(() => [] as string[])
      let verified = records.some(r => r.toLowerCase() === expectedTarget.toLowerCase())
      let resolvedVia: 'cname' | 'cf-proxy' | 'origin-ip' | null = verified ? 'cname' : null

      // 2) Quando ha Cloudflare proxy laranja, o CNAME e flattened pelo CF —
      //    DNS publico retorna IPs do Cloudflare (104.21.x.x, 172.67.x.x),
      //    nao o CNAME real. Verifica se o dominio resolve pra IPs CF E se
      //    o expectedTarget tambem resolve no fim da cadeia (sanidade).
      if (!verified) {
        const ips = await dns.resolve4(c.custom_domain).catch(() => [] as string[])
        const isCloudflare = ips.some(ip => ip.startsWith('104.21.') || ip.startsWith('172.67.'))
        if (isCloudflare) {
          // Faz HTTP HEAD pra checar que o dominio chega no Netlify (header
          // x-nf-request-id). Se chegou, OK — Cloudflare esta proxy-ando
          // pro nosso storefront.
          try {
            const r = await axios.head(`https://${c.custom_domain}/`, {
              timeout:   10_000,
              maxRedirects: 0,
              validateStatus: () => true, // qualquer status conta
            })
            if (r.headers['x-nf-request-id']) {
              verified = true
              resolvedVia = 'cf-proxy'
            }
          } catch { /* ignora */ }
        }
      }

      // 3) Fallback final — algumas configuracoes apontam direto IP do
      //    Netlify (75.2.60.5 etc) sem CNAME. Aceita se HTTP retorna header
      //    x-nf-request-id.
      if (!verified) {
        try {
          const r = await axios.head(`https://${c.custom_domain}/`, {
            timeout:   10_000,
            maxRedirects: 0,
            validateStatus: () => true,
          })
          if (r.headers['x-nf-request-id']) {
            verified = true
            resolvedVia = 'origin-ip'
          }
        } catch { /* ignora */ }
      }

      await supabaseAdmin
        .from('store_config')
        .update({ domain_verified: verified, ssl_status: verified ? 'active' : 'pending' })
        .eq('organization_id', orgId)

      if (verified) {
        return { verified: true, expected_target: expectedTarget }
      }
      return {
        verified: false,
        reason:   `Dominio nao aponta pra ${expectedTarget}. Detectado: CNAME=[${records.join(',') || 'nenhum'}].`,
        expected_target: expectedTarget,
      }
    } catch (e) {
      return { verified: false, reason: (e as Error).message, expected_target: expectedTarget }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // PUBLIC SSR (storefront)
  // ─────────────────────────────────────────────────────────────────

  /** Por slug ou domínio. Inclui `whatsapp_catalog` (enabled + phone +
   *  link wa.me/c/) quando a org tem channel whatsapp_business conectado
   *  em social_commerce_channels — usado pelo widget da Loja Propria. */
  async getPublicBySlugOrDomain(input: { slug?: string; domain?: string }): Promise<
    (StoreConfig & { whatsapp_catalog?: { enabled: boolean; phone: string | null; link: string | null } }) | null
  > {
    let q = supabaseAdmin.from('store_config').select('*').eq('status', 'active')
    if (input.slug)   q = q.eq('store_slug',   input.slug)
    if (input.domain) q = q.eq('custom_domain', input.domain)
    const { data, error } = await q.maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) return null
    const cfg = data as StoreConfig

    // Lookup WhatsApp Catalog (1 query — ignora erro pra nao quebrar a vitrine)
    const { data: wa } = await supabaseAdmin
      .from('social_commerce_channels')
      .select('status, config')
      .eq('organization_id', cfg.organization_id)
      .eq('channel', 'whatsapp_business')
      .maybeSingle()

    let whatsapp_catalog: { enabled: boolean; phone: string | null; link: string | null } | undefined
    if (wa && wa.status === 'connected') {
      const phone = ((wa.config as Record<string, unknown>)?.display_phone as string | null) ?? cfg.whatsapp_number ?? null
      const digits = phone ? phone.replace(/\D/g, '') : ''
      whatsapp_catalog = {
        enabled: true,
        phone,
        link: digits ? `https://wa.me/c/${digits}` : null,
      }
    }

    return whatsapp_catalog ? { ...cfg, whatsapp_catalog } : cfg
  }

  /** Lista produtos públicos da vitrine (storefront_visible=true, com estoque).
   *  Retorna dados ricos pro frontend renderizar cards completos sem fazer
   *  fetch detalhado por item (marca, atributos basicos, descricao curta,
   *  estoque pra badge "esgotando", created_at pra badge "novidade", etc). */
  async listPublicProducts(orgId: string, opts: { limit?: number; offset?: number; category?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const limit  = Math.min(opts.limit  ?? 24, 60)
    const offset = Math.max(opts.offset ?? 0, 0)
    let q = supabaseAdmin
      .from('products')
      .select([
        'id', 'name', 'sku', 'model',
        'price', 'cost_price', 'my_price',
        // Promoções por produto (migration 20260604)
        'sale_price', 'sale_start_at', 'sale_end_at', 'sale_badge_text',
        'photo_urls', 'images',
        'category', 'brand', 'condition',
        'stock', 'weight_kg',
        'gtin',
        'ai_score', 'ai_short_description', 'ai_long_description', 'ai_keywords',
        'bullets', 'description',
        'attributes',
        'wholesale_enabled', 'wholesale_levels',
        'sale_format',
        'created_at', 'updated_at',
      ].join(','))
      .eq('organization_id', orgId)
      .eq('storefront_visible', true)
      .gt('stock', 0)
      .order('ai_score', { ascending: false })
      .range(offset, offset + limit - 1)
    if (opts.category) q = q.eq('category', opts.category)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
    // Calcula campos derivados de promoção (effective_price, on_sale, discount_pct)
    // pra vitrine renderizar sem repetir lógica.
    const now = Date.now()
    return rows.map(r => enrichWithPromotionFields(r, now))
  }

  /** Detalhe de produto público. */
  async getPublicProduct(orgId: string, productId: string): Promise<Record<string, unknown> | null> {
    const { data } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', productId)
      .eq('storefront_visible', true)
      .maybeSingle()
    if (!data) return null
    return enrichWithPromotionFields(data as Record<string, unknown>, Date.now())
  }

  /** Aplica/remove promoção em um produto. Aceita partial — null limpa o
   *  campo (ex: remover janela de fim). Valida sale_price > 0 e <= price. */
  async setProductPromotion(
    orgId: string,
    productId: string,
    patch: {
      sale_price?: number | null
      sale_start_at?: string | null
      sale_end_at?: string | null
      sale_badge_text?: string | null
    },
  ): Promise<{ ok: true }> {
    const fields: Record<string, unknown> = {}
    if ('sale_price'      in patch) fields.sale_price      = patch.sale_price
    if ('sale_start_at'   in patch) fields.sale_start_at   = patch.sale_start_at
    if ('sale_end_at'     in patch) fields.sale_end_at     = patch.sale_end_at
    if ('sale_badge_text' in patch) fields.sale_badge_text = patch.sale_badge_text

    if (Object.keys(fields).length === 0) {
      throw new BadRequestException('Nenhum campo de promoção informado')
    }

    // Validação cruzada: se sale_price > 0, deve ser <= price atual
    if (typeof patch.sale_price === 'number' && patch.sale_price > 0) {
      const { data: p } = await supabaseAdmin
        .from('products').select('price').eq('id', productId).eq('organization_id', orgId).maybeSingle()
      if (p && typeof (p as { price?: number }).price === 'number' && patch.sale_price >= (p as { price: number }).price) {
        throw new BadRequestException('sale_price deve ser menor que price')
      }
    }

    const { error } = await supabaseAdmin
      .from('products')
      .update(fields)
      .eq('id', productId)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao salvar promoção: ${error.message}`)
    return { ok: true }
  }

  /** Bulk: aplica MESMO patch em vários produtos (ex: "20% off em 50
   *  produtos selecionados"). Pra desconto percentual o frontend resolve
   *  produto-a-produto e chama múltiplos setProductPromotion via Promise.all
   *  — aqui só aplica datas/badge_text em batch. */
  async bulkSetPromotionMetadata(
    orgId: string,
    productIds: string[],
    patch: {
      sale_start_at?: string | null
      sale_end_at?: string | null
      sale_badge_text?: string | null
    },
  ): Promise<{ updated: number }> {
    if (productIds.length === 0) return { updated: 0 }
    const fields: Record<string, unknown> = {}
    if ('sale_start_at'   in patch) fields.sale_start_at   = patch.sale_start_at
    if ('sale_end_at'     in patch) fields.sale_end_at     = patch.sale_end_at
    if ('sale_badge_text' in patch) fields.sale_badge_text = patch.sale_badge_text
    if (Object.keys(fields).length === 0) return { updated: 0 }
    const { error, count } = await supabaseAdmin
      .from('products')
      .update(fields, { count: 'exact' })
      .eq('organization_id', orgId)
      .in('id', productIds)
    if (error) throw new BadRequestException(`Erro bulk: ${error.message}`)
    return { updated: count ?? productIds.length }
  }

  /** Lista produtos pra dashboard de promoções (filtros: ativa, agendada,
   *  expirada, sem). Retorna campos mínimos pra grid editável. */
  async listProductsForPromotionAdmin(
    orgId: string,
    opts: {
      filter?: 'all' | 'active' | 'scheduled' | 'expired' | 'none'
      q?:      string
      limit?:  number
      offset?: number
    } = {},
  ): Promise<{ products: Array<Record<string, unknown>>; total: number }> {
    const limit  = Math.min(opts.limit ?? 50, 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    const nowIso = new Date().toISOString()

    let q = supabaseAdmin
      .from('products')
      .select('id, name, sku, price, sale_price, sale_start_at, sale_end_at, sale_badge_text, photo_urls, stock, storefront_visible, category', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (opts.q?.trim()) {
      const esc = opts.q.trim().replace(/[%]/g, '')
      q = q.or(`name.ilike.%${esc}%,sku.ilike.%${esc}%`)
    }

    // Filtros de janela
    switch (opts.filter) {
      case 'active':
        // sale_price NOT NULL E (start IS NULL OR start <= now) E (end IS NULL OR end > now)
        q = q.not('sale_price', 'is', null)
        q = q.or(`sale_start_at.is.null,sale_start_at.lte.${nowIso}`)
        q = q.or(`sale_end_at.is.null,sale_end_at.gt.${nowIso}`)
        break
      case 'scheduled':
        q = q.not('sale_price', 'is', null)
        q = q.gt('sale_start_at', nowIso)
        break
      case 'expired':
        q = q.not('sale_price', 'is', null)
        q = q.lte('sale_end_at', nowIso)
        break
      case 'none':
        q = q.is('sale_price', null)
        break
    }

    const { data, error, count } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const now = Date.now()
    const products = (data ?? []).map(r => enrichWithPromotionFields(r as Record<string, unknown>, now))
    return { products, total: count ?? 0 }
  }
}

// ── Helpers de promoção ─────────────────────────────────────────────────────

/** Calcula preço efetivo considerando janela ativa. Se sale_price não
 *  estiver setado ou janela inativa, retorna price. */
export function getEffectivePrice(
  product: { price: number | null; sale_price?: number | null; sale_start_at?: string | null; sale_end_at?: string | null },
  nowMs = Date.now(),
): number {
  const price = Number(product.price ?? 0)
  const sale  = product.sale_price
  if (sale == null || Number(sale) <= 0) return price
  if (Number(sale) >= price)             return price  // safety
  if (product.sale_start_at && nowMs < Date.parse(product.sale_start_at)) return price
  if (product.sale_end_at   && nowMs > Date.parse(product.sale_end_at))   return price
  return Number(sale)
}

/** Anexa campos derivados (effective_price, on_sale, discount_pct) ao
 *  objeto retornado pro frontend. Mantém price/sale_price originais. */
function enrichWithPromotionFields(row: Record<string, unknown>, nowMs: number): Record<string, unknown> {
  const price        = Number(row.price ?? 0)
  const salePrice    = row.sale_price
  const effective    = getEffectivePrice(row as { price: number | null; sale_price?: number | null; sale_start_at?: string | null; sale_end_at?: string | null }, nowMs)
  const onSale       = effective < price && effective > 0
  const discountPct  = onSale && price > 0 ? Math.round(((price - effective) / price) * 100) : 0
  return {
    ...row,
    effective_price: effective,
    on_sale:         onSale,
    discount_pct:    discountPct,
    // sale_price também já vem do row; mantém pra UI saber se há promoção
    // setada (mesmo que janela inativa → on_sale=false).
    has_sale_set:    salePrice != null && Number(salePrice) > 0,
  }
}
