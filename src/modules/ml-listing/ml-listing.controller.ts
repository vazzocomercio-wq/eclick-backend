import { Controller, Get, Post, Patch, Body, Query, Param, UseGuards, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { MlListingService } from './services/ml-listing.service'
import type { TaskType, TaskSeverity, TaskStatus } from './ml-listing.types'

interface AuthUser { id: string; orgId: string | null }

/**
 * F10 ML Listing Center IA — endpoints L1 (Sprint 1).
 *
 * Sprint 1 entrega: agregação F7/F8/F9 + scanner de estoque.
 * Sprints futuras adicionam status/pricing/automation/fiscal/catalog/policy.
 *
 * Padrão multi-conta: rotas de scan exigem `seller_id` no body. UI passa
 * o seller_id selecionado pelo AccountSelector.
 */
@Controller('listings')
@UseGuards(SupabaseAuthGuard)
export class MlListingController {
  constructor(private readonly svc: MlListingService) {}

  // ── Dashboard / Summary ──────────────────────────────────────────────────

  @Get('summary')
  getSummary(@ReqUser() user: AuthUser, @Query('seller_id') sellerId?: string) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.svc.getSummary(user.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  @Get('tasks')
  listTasks(
    @ReqUser() user: AuthUser,
    @Query('task_type')   taskType?: TaskType,
    @Query('severity')    severity?: TaskSeverity,
    @Query('status')      status?:   TaskStatus,
    @Query('source')      source?:   string,
    @Query('ml_item_id')  itemId?:   string,
    @Query('product_id')  productId?: string,
    @Query('seller_id')   sellerId?: string,
    @Query('offset')      offset?:   string,
    @Query('limit')       limit?:    string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.svc.listTasks(user.orgId, {
      task_type:   taskType,
      severity,
      status,
      source,
      ml_item_id:  itemId,
      product_id:  productId,
      seller_id:   sellerId ? Number(sellerId) : undefined,
      offset:      offset ? Number(offset) : 0,
      limit:       limit  ? Number(limit)  : 50,
    })
  }

  @Get('tasks/:id')
  getTask(@ReqUser() user: AuthUser, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.svc.getTask(user.orgId, id)
  }

  @Patch('tasks/:id')
  patchTask(
    @ReqUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { action: 'snooze' | 'dismiss' | 'resolve'; days?: number; reason?: string; notes?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (body.action === 'snooze') {
      return this.svc.snoozeTask(user.orgId, id, body.days ?? 7)
    }
    if (body.action === 'dismiss') {
      return this.svc.dismissTask(user.orgId, id, user.id, body.reason)
    }
    if (body.action === 'resolve') {
      return this.svc.resolveTaskManual(user.orgId, id, user.id, body.notes)
    }
    throw new BadRequestException('action inválida — use snooze | dismiss | resolve')
  }

  // ── Visão por anúncio ────────────────────────────────────────────────────

  @Get('items/:itemId')
  getItemTasks(@ReqUser() user: AuthUser, @Param('itemId') itemId: string) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.svc.listTasksByItem(user.orgId, itemId)
  }

  // ── Atalhos ──────────────────────────────────────────────────────────────

  @Get('out-of-stock')
  listOutOfStock(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerId?: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.svc.listOutOfStock(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
      limit ? Number(limit) : 100,
    )
  }

  @Get('inactive')
  listInactive(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerId?: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.svc.listInactive(
      user.orgId,
      sellerId ? Number(sellerId) : undefined,
      limit ? Number(limit) : 100,
    )
  }

  // ── Scans ────────────────────────────────────────────────────────────────

  @Post('scan/full')
  @HttpCode(HttpStatus.OK)
  runFullScan(@ReqUser() user: AuthUser, @Body() body: { seller_id: number }) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!body?.seller_id) throw new BadRequestException('seller_id é obrigatório')
    return this.svc.runFullScan(user.orgId, Number(body.seller_id))
  }

  @Post('scan/aggregation')
  @HttpCode(HttpStatus.OK)
  runAggregation(@ReqUser() user: AuthUser, @Body() body: { seller_id?: number }) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.svc.runAggregationOnly(
      user.orgId,
      body?.seller_id ? Number(body.seller_id) : undefined,
    )
  }

  @Post('scan/stock')
  @HttpCode(HttpStatus.OK)
  runStockScan(@ReqUser() user: AuthUser, @Body() body: { seller_id: number }) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!body?.seller_id) throw new BadRequestException('seller_id é obrigatório')
    return this.svc.runStockScan(user.orgId, Number(body.seller_id))
  }

  @Post('scan/status')
  @HttpCode(HttpStatus.OK)
  runStatusScan(@ReqUser() user: AuthUser, @Body() body: { seller_id: number }) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!body?.seller_id) throw new BadRequestException('seller_id é obrigatório')
    return this.svc.runStatusScan(user.orgId, Number(body.seller_id))
  }

  @Post('scan/pricing')
  @HttpCode(HttpStatus.OK)
  runPricingScan(@ReqUser() user: AuthUser, @Body() body: { seller_id: number }) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!body?.seller_id) throw new BadRequestException('seller_id é obrigatório')
    return this.svc.runPricingScan(user.orgId, Number(body.seller_id))
  }

  // ── Pricing — sugestões ──────────────────────────────────────────────────

  @Get('pricing/suggestions')
  listSuggestions(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerId?: string,
    @Query('buy_box_status') buyBoxStatus?: 'winning' | 'losing' | 'sharing_first_place',
    @Query('min_diff_pct') minDiffPct?: string,
    @Query('offset') offset?: string,
    @Query('limit')  limit?:  string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.svc.listPricingSuggestions(user.orgId, {
      seller_id:      sellerId ? Number(sellerId) : undefined,
      buy_box_status: buyBoxStatus,
      min_diff_pct:   minDiffPct ? Number(minDiffPct) : undefined,
      offset:         offset ? Number(offset) : 0,
      limit:          limit  ? Number(limit)  : 50,
    })
  }

  @Get('pricing/suggestions/:itemId')
  getSuggestion(
    @ReqUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Query('seller_id') sellerId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!sellerId) throw new BadRequestException('seller_id (query) é obrigatório')
    return this.svc.pricing().getSuggestion(user.orgId, Number(sellerId), itemId)
  }

  @Post('pricing/apply/:itemId')
  @HttpCode(HttpStatus.OK)
  async applyPrice(
    @ReqUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: { seller_id: number; mode?: 'safe' | 'force'; price?: number },
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!body?.seller_id) throw new BadRequestException('seller_id é obrigatório')
    return this.svc.pricing().applyPrice(
      user.orgId,
      Number(body.seller_id),
      itemId,
      body.mode ?? 'safe',
      body.price ? Number(body.price) : undefined,
    )
  }
}
