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

  /** Por slug ou domínio. */
  async getPublicBySlugOrDomain(input: { slug?: string; domain?: string }): Promise<StoreConfig | null> {
    let q = supabaseAdmin.from('store_config').select('*').eq('status', 'active')
    if (input.slug)   q = q.eq('store_slug',   input.slug)
    if (input.domain) q = q.eq('custom_domain', input.domain)
    const { data, error } = await q.maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data as StoreConfig) ?? null
  }

  /** Lista produtos públicos (catalog_status='live'). */
  async listPublicProducts(orgId: string, opts: { limit?: number; offset?: number; category?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const limit  = Math.min(opts.limit  ?? 24, 60)
    const offset = Math.max(opts.offset ?? 0, 0)
    let q = supabaseAdmin
      .from('products')
      .select('id, name, price, photo_urls, category, ai_score, ai_short_description')
      .eq('organization_id', orgId)
      .in('catalog_status', ['ready', 'live'])
      .gt('stock', 0)
      .order('ai_score', { ascending: false })
      .range(offset, offset + limit - 1)
    if (opts.category) q = q.eq('category', opts.category)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as Array<Record<string, unknown>>
  }

  /** Detalhe de produto público. */
  async getPublicProduct(orgId: string, productId: string): Promise<Record<string, unknown> | null> {
    const { data } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', productId)
      .in('catalog_status', ['ready', 'live'])
      .maybeSingle()
    return data ?? null
  }
}
