import { Controller, Get, Post, Param, Body, Req, Logger, HttpException } from '@nestjs/common'
import type { Request } from 'express'
import { LeadBridgeService } from './lead-bridge.service'
import { CustomerIdentityService } from '../customers/customer-identity.service'
import { CpfEnrichmentService } from './services/cpf-enrichment.service'
import { WhatsAppTriggerService } from './services/whatsapp-trigger.service'
import { supabaseAdmin } from '../../common/supabase'

@Controller('lb')
export class LeadBridgePublicController {
  private readonly logger = new Logger(LeadBridgePublicController.name)

  constructor(
    private readonly svc: LeadBridgeService,
    private readonly customers: CustomerIdentityService,
    private readonly cpfEnrich: CpfEnrichmentService,
    private readonly waTrigger: WhatsAppTriggerService,
  ) {}

  /** GET /lb/:token — landing-page metadata. Logs a scan as a side effect. */
  @Get(':token')
  async metadata(@Param('token') token: string) {
    try {
      const lookup = await this.svc.getLinkByToken(token)
      if (!lookup) return { ok: false, error: 'Link inválido ou expirado' }
      const { link, config } = lookup
      return {
        ok: true,
        channel:     link.channel,
        order_id:    link.order_id,
        product_name: link.product_name,
        marketplace: link.marketplace,
        config: {
          brand_color:           config.brand_color,
          brand_logo_url:        config.brand_logo_url,
          rastreio_landing_title:  config.rastreio_landing_title,
          rastreio_incentive_text: config.rastreio_incentive_text,
          garantia_cupom_code:   config.garantia_cupom_code,
          garantia_cupom_value:  config.garantia_cupom_value,
          garantia_months:       config.garantia_months,
          posvenda_thank_you_msg: config.posvenda_thank_you_msg,
        },
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[lb.public.meta] ${err?.message}`)
      return { ok: false, error: 'Erro ao carregar página' }
    }
  }

  /** POST /lb/:token/convert — accepts the form submission. */
  @Post(':token/convert')
  async convert(
    @Param('token') token: string,
    @Body() body: {
      full_name?:      string
      cpf?:            string
      email?:          string
      phone?:          string
      whatsapp?:       string
      birth_date?:     string
      consent_marketing?:  boolean
      consent_whatsapp?:   boolean
      consent_enrichment?: boolean
    },
    @Req() req: Request,
  ) {
    try {
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                  ?? req.socket.remoteAddress
                  ?? null
      const result = await this.svc.recordConversion({ token, ...body, consent_ip: ip ?? undefined })

      // Resolve / create the unified customer by phone (best-effort) and stamp
      // the conversion with the unified id so it shows up in /clientes.
      let unifiedId: string | null = null
      const phone = body.phone ?? body.whatsapp ?? null
      if (phone) {
        const customer = await this.customers.resolveByPhone(phone, body.full_name, 'lead-bridge')
        if (customer) {
          unifiedId = customer.id
          await supabaseAdmin
            .from('lead_bridge_conversions')
            .update({ unified_customer_id: customer.id })
            .eq('id', result.conversion.id)
        }
      }

      // Fire-and-forget side effects — never block the user response.
      const convId = result.conversion.id as string
      if (body.consent_enrichment && body.cpf) {
        this.cpfEnrich.enrich(convId).catch(() => { /* logged inside */ })
      }
      if (body.consent_whatsapp && phone) {
        this.waTrigger.sendWelcome(convId).catch(() => { /* logged inside */ })
        this.waTrigger.startJourneyRun(convId, result.link.channel as string).catch(() => { /* logged inside */ })
      }

      return {
        success: true,
        message: result.config.posvenda_thank_you_msg ?? 'Recebemos seus dados! Em breve entraremos em contato.',
        customer_id: unifiedId,
        conversion_id: result.conversion.id,
      }
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e
      const err = e as { message?: string }
      this.logger.error(`[lb.public.convert] ${err?.message}`)
      return { success: false, message: 'Não conseguimos registrar seus dados. Tente novamente.' }
    }
  }

  /** GET /lb/:token/track — used by rastreio QR codes. Returns metadata
   * plus, when the link carries an order_id, a status snapshot from the
   * orders table so the buyer sees something useful even before opting in. */
  @Get(':token/track')
  async track(@Param('token') token: string) {
    try {
      const lookup = await this.svc.getLinkByToken(token)
      if (!lookup) return { ok: false, error: 'Link inválido' }
      const { link } = lookup

      let order: Record<string, unknown> | null = null
      if (link.order_id) {
        const { data } = await supabaseAdmin
          .from('orders')
          .select('external_order_id, status, sold_at, sale_price, product_name')
          .eq('external_order_id', link.order_id)
          .maybeSingle()
        order = data ?? null
      }
      return { ok: true, channel: link.channel, link, order }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[lb.public.track] ${err?.message}`)
      return { ok: false, error: 'Erro ao consultar' }
    }
  }
}
