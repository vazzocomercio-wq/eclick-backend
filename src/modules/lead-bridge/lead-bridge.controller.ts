import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Logger } from '@nestjs/common'
import { LeadBridgeService } from './lead-bridge.service'
import type { LeadBridgeConfig } from './lead-bridge.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('lead-bridge')
@UseGuards(SupabaseAuthGuard)
export class LeadBridgeController {
  private readonly logger = new Logger(LeadBridgeController.name)

  constructor(private readonly svc: LeadBridgeService) {}

  // safe<T> — every handler returns 200 even on failure with a typed fallback,
  // so the dashboard can render an empty state instead of a 500.
  private async safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await fn() } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[lead-bridge] ${label}: ${err?.message}`)
      return fallback
    }
  }

  // ── Config ──
  @Get('config')
  config(@ReqUser() u: ReqUserPayload) {
    return this.safe('config.get', () => this.svc.getConfig(u.orgId ?? ''), null)
  }

  @Patch('config')
  updateConfig(@ReqUser() u: ReqUserPayload, @Body() body: Partial<LeadBridgeConfig>) {
    return this.safe('config.update', () => this.svc.updateConfig(u.orgId ?? '', body), null)
  }

  // ── Links ──
  @Get('links')
  links(
    @ReqUser() u: ReqUserPayload,
    @Query('channel') channel?: string,
    @Query('from')    from?: string,
    @Query('to')      to?: string,
  ) {
    return this.safe('links.list', () => this.svc.listLinks(u.orgId ?? '', { channel, from, to }), [])
  }

  @Post('links/generate')
  generateLink(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { channel: 'rastreio' | 'garantia' | 'posvenda'; order_id?: string; product_sku?: string; product_name?: string; marketplace?: string; marketplace_buyer_id?: string },
  ) {
    return this.safe('links.generate', () => this.svc.generateLink(u.orgId ?? '', body), null)
  }

  @Post('links/bulk-generate')
  bulkGenerate(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { channel: 'rastreio' | 'garantia' | 'posvenda'; from: string; to: string },
  ) {
    return this.safe('links.bulk', () => this.svc.bulkGenerate(u.orgId ?? '', body.channel, body.from, body.to), { generated: 0, links: [] })
  }

  // ── Conversions ──
  @Get('conversions')
  conversions(
    @ReqUser() u: ReqUserPayload,
    @Query('channel') channel?: string,
    @Query('from')    from?: string,
    @Query('to')      to?: string,
  ) {
    return this.safe('conversions.list', () => this.svc.listConversions(u.orgId ?? '', { channel, from, to }), [])
  }

  @Get('conversions/:id')
  conversionDetail(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.safe('conversions.detail', () => this.svc.getConversion(u.orgId ?? '', id), null)
  }

  // ── Analytics ──
  @Get('analytics/funnel')
  funnel(@ReqUser() u: ReqUserPayload) {
    return this.safe('analytics.funnel', () => this.svc.funnel(u.orgId ?? ''), {
      links: 0, scans: 0, conversions: 0, converted_links: 0, scan_rate: 0, conversion_rate: 0,
    })
  }

  @Get('analytics/by-channel')
  byChannel(@ReqUser() u: ReqUserPayload) {
    return this.safe('analytics.by-channel', () => this.svc.byChannel(u.orgId ?? ''), [])
  }

  // ── Journeys ──
  @Get('journeys')
  journeys(@ReqUser() u: ReqUserPayload) {
    return this.safe('journeys.list', () => this.svc.listJourneys(u.orgId ?? ''), [])
  }

  @Post('journeys')
  createJourney(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { name: string; trigger_channel: string | null; steps: unknown[] },
  ) {
    return this.safe('journeys.create', () => this.svc.createJourney(u.orgId ?? '', body), null)
  }

  @Patch('journeys/:id')
  updateJourney(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<{ name: string; trigger_channel: string | null; is_active: boolean; steps: unknown[] }>,
  ) {
    return this.safe('journeys.update', () => this.svc.updateJourney(u.orgId ?? '', id, body), null)
  }
}
