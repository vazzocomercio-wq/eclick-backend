import { Injectable, Logger, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LinkGeneratorService } from './services/link-generator.service'

const PUBLIC_BASE = process.env.PUBLIC_FRONTEND_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.eclick.com.br'

export interface LeadBridgeConfig {
  id?: string
  organization_id: string
  rastreio_enabled: boolean
  rastreio_landing_title: string | null
  rastreio_incentive_text: string | null
  garantia_enabled: boolean
  garantia_cupom_code: string | null
  garantia_cupom_value: number | null
  garantia_months: number
  posvenda_enabled: boolean
  posvenda_thank_you_msg: string | null
  cpf_enrichment_enabled: boolean
  cpf_provider: string
  cpf_api_key: string | null
  whatsapp_auto_message_enabled: boolean
  whatsapp_welcome_template: string | null
  brand_color: string
  brand_logo_url: string | null
}

const DEFAULT_CONFIG: Omit<LeadBridgeConfig, 'organization_id'> = {
  rastreio_enabled: true,
  rastreio_landing_title: 'Acompanhe seu pedido',
  rastreio_incentive_text: null,
  garantia_enabled: true,
  garantia_cupom_code: null,
  garantia_cupom_value: null,
  garantia_months: 12,
  posvenda_enabled: true,
  posvenda_thank_you_msg: null,
  cpf_enrichment_enabled: false,
  cpf_provider: 'bigdatacorp',
  cpf_api_key: null,
  whatsapp_auto_message_enabled: true,
  whatsapp_welcome_template: null,
  brand_color: '#00E5FF',
  brand_logo_url: null,
}

@Injectable()
export class LeadBridgeService {
  private readonly logger = new Logger(LeadBridgeService.name)

  constructor(private readonly linkGen: LinkGeneratorService) {}

  // ── Config ────────────────────────────────────────────────────────────────

  async getConfig(orgId: string): Promise<LeadBridgeConfig> {
    const { data: existing } = await supabaseAdmin
      .from('lead_bridge_configs')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (existing) return existing as LeadBridgeConfig

    // Auto-create: garante que toda org tem row persistida com defaults
    // (antes retornávamos só o objeto em memória — updateConfig dependia
    // do upsert pra criar; agora getConfig é canônico).
    const { data: created, error } = await supabaseAdmin
      .from('lead_bridge_configs')
      .insert({ organization_id: orgId, ...DEFAULT_CONFIG })
      .select()
      .single()
    if (error) throw new HttpException(`Falha ao criar config: ${error.message}`, 500)
    return created as LeadBridgeConfig
  }

  async updateConfig(orgId: string, patch: Partial<LeadBridgeConfig>): Promise<LeadBridgeConfig> {
    const current = await this.getConfig(orgId)
    const merged  = { ...current, ...patch, organization_id: orgId, updated_at: new Date().toISOString() }
    const { data, error } = await supabaseAdmin
      .from('lead_bridge_configs')
      .upsert(merged, { onConflict: 'organization_id' })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data as LeadBridgeConfig
  }

  // ── Links ─────────────────────────────────────────────────────────────────

  async listLinks(orgId: string, filters: { channel?: string; from?: string; to?: string }) {
    let q = supabaseAdmin
      .from('lead_bridge_links')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(500)
    if (filters.channel) q = q.eq('channel', filters.channel)
    if (filters.from)    q = q.gte('created_at', filters.from)
    if (filters.to)      q = q.lte('created_at', filters.to)
    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async generateLink(orgId: string, input: {
    channel: 'rastreio' | 'garantia' | 'posvenda'
    order_id?:        string
    product_sku?:     string
    product_name?:    string
    marketplace?:     string
    marketplace_buyer_id?: string
  }) {
    const token = await this.linkGen.generateUniqueToken()
    const publicUrl = `${PUBLIC_BASE}/lb/${token}`
    const qrUrl     = this.linkGen.qrCodeUrl(publicUrl)

    const { data, error } = await supabaseAdmin
      .from('lead_bridge_links')
      .insert({
        organization_id: orgId,
        channel:         input.channel,
        short_token:     token,
        order_id:        input.order_id ?? null,
        product_sku:     input.product_sku ?? null,
        product_name:    input.product_name ?? null,
        marketplace:     input.marketplace ?? null,
        marketplace_buyer_id: input.marketplace_buyer_id ?? null,
        qr_code_url:     qrUrl,
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return { ...data, public_url: publicUrl }
  }

  async bulkGenerate(orgId: string, channel: 'rastreio' | 'garantia' | 'posvenda', dateFrom: string, dateTo: string) {
    // Pull recent orders that have items so we can stamp product_sku/name.
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('external_order_id, sku, product_name, source')
      .eq('organization_id', orgId)
      .gte('sold_at', dateFrom)
      .lte('sold_at', dateTo)
      .limit(500)

    const out = []
    for (const o of orders ?? []) {
      try {
        const link = await this.generateLink(orgId, {
          channel,
          order_id:     o.external_order_id as string | undefined,
          product_sku:  o.sku as string | undefined,
          product_name: o.product_name as string | undefined,
          marketplace:  o.source as string | undefined,
        })
        out.push(link)
      } catch (e: any) {
        this.logger.warn(`[lb.bulk] order=${o.external_order_id}: ${e?.message}`)
      }
    }
    return { generated: out.length, links: out }
  }

  // ── Conversions ───────────────────────────────────────────────────────────

  async listConversions(orgId: string, filters: { channel?: string; from?: string; to?: string }) {
    let q = supabaseAdmin
      .from('lead_bridge_conversions')
      .select('*, link:lead_bridge_links(channel, order_id, product_name, marketplace)')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(500)
    if (filters.channel) q = q.eq('channel', filters.channel)
    if (filters.from)    q = q.gte('created_at', filters.from)
    if (filters.to)      q = q.lte('created_at', filters.to)
    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getConversion(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('lead_bridge_conversions')
      .select('*, link:lead_bridge_links(*)')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    return data ?? null
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  async funnel(orgId: string) {
    const [{ count: totalLinks }, { count: scannedLinks }, { count: convertedLinks }, { count: totalConvs }] =
      await Promise.all([
        supabaseAdmin.from('lead_bridge_links').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
        supabaseAdmin.from('lead_bridge_links').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).gt('scanned_count', 0),
        supabaseAdmin.from('lead_bridge_links').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).not('converted_at', 'is', null),
        supabaseAdmin.from('lead_bridge_conversions').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
      ])
    const links = totalLinks ?? 0
    const scans = scannedLinks ?? 0
    const conv  = convertedLinks ?? 0
    const all   = totalConvs ?? 0
    return {
      links,
      scans,
      conversions: all,
      converted_links: conv,
      scan_rate:        links > 0 ? scans / links : 0,
      conversion_rate:  scans > 0 ? conv / scans : 0,
    }
  }

  async byChannel(orgId: string) {
    const channels = ['rastreio', 'garantia', 'posvenda'] as const
    const rows = await Promise.all(channels.map(async ch => {
      const [{ count: links }, { count: convs }] = await Promise.all([
        supabaseAdmin.from('lead_bridge_links').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('channel', ch),
        supabaseAdmin.from('lead_bridge_conversions').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('channel', ch),
      ])
      return { channel: ch, links: links ?? 0, conversions: convs ?? 0 }
    }))
    return rows
  }

  // ── Journeys ──────────────────────────────────────────────────────────────

  async listJourneys(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('lead_bridge_journeys')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async createJourney(orgId: string, input: { name: string; trigger_channel: string | null; steps: unknown[] }) {
    const { data, error } = await supabaseAdmin
      .from('lead_bridge_journeys')
      .insert({
        organization_id: orgId,
        name: input.name,
        trigger_channel: input.trigger_channel,
        steps: input.steps ?? [],
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  async updateJourney(orgId: string, id: string, patch: Partial<{ name: string; trigger_channel: string | null; is_active: boolean; steps: unknown[] }>) {
    const { data, error } = await supabaseAdmin
      .from('lead_bridge_journeys')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data
  }

  // ── Public-page lookups (called by the anonymous controller) ──────────────

  async getLinkByToken(token: string) {
    const { data, error } = await supabaseAdmin
      .from('lead_bridge_links')
      .select('*')
      .eq('short_token', token)
      .maybeSingle()
    if (error || !data) return null

    // Stamp scan
    await supabaseAdmin
      .from('lead_bridge_links')
      .update({
        scanned_count: (data.scanned_count ?? 0) + 1,
        last_scanned_at: new Date().toISOString(),
      })
      .eq('id', data.id)

    // Pull org config so the landing can render branding + which fields to ask
    const config = await this.getConfig(data.organization_id as string)
    return { link: data, config }
  }

  async recordConversion(input: {
    token:           string
    full_name?:      string
    cpf?:            string
    email?:          string
    phone?:          string
    whatsapp?:       string
    birth_date?:     string
    consent_marketing?:  boolean
    consent_whatsapp?:   boolean
    consent_enrichment?: boolean
    consent_ip?:    string
  }) {
    const lookup = await this.getLinkByToken(input.token)
    if (!lookup) throw new HttpException('Link inválido ou expirado', 404)
    const { link } = lookup

    const phone   = input.phone ?? input.whatsapp ?? null
    const wa      = input.whatsapp ?? input.phone ?? null

    const { data: conv, error } = await supabaseAdmin
      .from('lead_bridge_conversions')
      .insert({
        organization_id: link.organization_id,
        link_id:         link.id,
        channel:         link.channel,
        full_name:       input.full_name ?? null,
        cpf:             input.cpf ?? null,
        email:           input.email ?? null,
        phone,
        whatsapp:        wa,
        birth_date:      input.birth_date ?? null,
        consent_marketing:  input.consent_marketing  ?? false,
        consent_whatsapp:   input.consent_whatsapp   ?? false,
        consent_enrichment: input.consent_enrichment ?? false,
        consent_ip:      input.consent_ip ?? null,
      })
      .select()
      .single()
    if (error) throw new HttpException(error.message, 500)

    await supabaseAdmin
      .from('lead_bridge_links')
      .update({ converted_at: new Date().toISOString() })
      .eq('id', link.id)

    return { conversion: conv, link, config: lookup.config }
  }
}
