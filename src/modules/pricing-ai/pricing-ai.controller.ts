import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import { PricingAiService } from './pricing-ai.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import type {
  PricingSuggestionStatus, PricingRules,
} from './pricing-ai.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 4 / A1 — Pricing AI endpoints.
 *
 * POST   /pricing-ai/analyze
 * POST   /pricing-ai/analyze/:productId
 * GET    /pricing-ai/suggestions
 * GET    /pricing-ai/suggestions/:id
 * POST   /pricing-ai/suggestions/:id/approve
 * POST   /pricing-ai/suggestions/:id/reject
 * POST   /pricing-ai/suggestions/approve-batch
 * GET    /pricing-ai/rules
 * PATCH  /pricing-ai/rules
 * GET    /pricing-ai/history/:productId
 * GET    /pricing-ai/dashboard
 */
@Controller('pricing-ai')
@UseGuards(SupabaseAuthGuard)
export class PricingAiController {
  constructor(private readonly svc: PricingAiService) {}

  /** POST /pricing-ai/analyze — análise em massa (até 50 produtos). */
  @Post('analyze')
  @HttpCode(HttpStatus.OK)
  analyzeAll(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { product_ids?: string[]; max_items?: number } = {},
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.analyzeAll(u.orgId, {
      productIds: body.product_ids,
      maxItems:   body.max_items,
    })
  }

  /** POST /pricing-ai/analyze/:productId */
  @Post('analyze/:productId')
  @HttpCode(HttpStatus.OK)
  analyzeOne(
    @ReqUser() u: ReqUserPayload,
    @Param('productId') productId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.analyzeProduct(u.orgId, productId)
  }

  /** GET /pricing-ai/suggestions */
  @Get('suggestions')
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status')     status?:    PricingSuggestionStatus,
    @Query('product_id') productId?: string,
    @Query('limit')      limitRaw?:  string,
    @Query('offset')     offsetRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listSuggestions(u.orgId, {
      status, productId,
      limit:  limitRaw  ? parseInt(limitRaw, 10)  : undefined,
      offset: offsetRaw ? parseInt(offsetRaw, 10) : undefined,
    })
  }

  /** GET /pricing-ai/suggestions/:id */
  @Get('suggestions/:id')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSuggestion(id, u.orgId)
  }

  /** POST /pricing-ai/suggestions/:id/approve */
  @Post('suggestions/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { override_price?: number } = {},
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.approve(id, u.orgId, body.override_price)
  }

  /** POST /pricing-ai/suggestions/:id/reject */
  @Post('suggestions/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { reason?: string } = {},
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.reject(id, u.orgId, body.reason)
  }

  /** POST /pricing-ai/suggestions/approve-batch */
  @Post('suggestions/approve-batch')
  @HttpCode(HttpStatus.OK)
  approveBatch(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { ids: string[] },
  ) {
    if (!u.orgId)                throw new BadRequestException('orgId ausente')
    if (!body?.ids?.length)      throw new BadRequestException('ids obrigatório')
    return this.svc.approveBatch(u.orgId, body.ids)
  }

  /** GET /pricing-ai/rules */
  @Get('rules')
  getRules(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getRules(u.orgId)
  }

  /** PATCH /pricing-ai/rules */
  @Patch('rules')
  updateRules(
    @ReqUser() u: ReqUserPayload,
    @Body() body: Partial<PricingRules>,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateRules(u.orgId, body)
  }

  /** GET /pricing-ai/history/:productId */
  @Get('history/:productId')
  history(
    @ReqUser() u: ReqUserPayload,
    @Param('productId') productId: string,
    @Query('limit') limitRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const limit = limitRaw ? parseInt(limitRaw, 10) : 30
    return this.svc.productHistory(u.orgId, productId, limit)
  }

  /** GET /pricing-ai/dashboard */
  @Get('dashboard')
  dashboard(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.dashboard(u.orgId)
  }
}
