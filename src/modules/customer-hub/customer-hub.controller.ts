import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CustomerHubService, CustomerSegment } from './customer-hub.service'
import { SegmentEvaluatorService, SegmentRule } from './segment-evaluator.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('customer-hub')
@UseGuards(SupabaseAuthGuard)
export class CustomerHubController {
  constructor(
    private readonly svc: CustomerHubService,
    private readonly evaluator: SegmentEvaluatorService,
  ) {}

  // ── Métricas e ABC ──────────────────────────────────────────────────────

  @Get('overview')
  overview(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getOverview(user.orgId)
  }

  @Post('compute')
  @HttpCode(HttpStatus.OK)
  compute(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.computeMetrics(user.orgId)
  }

  @Get('abc')
  abc(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getAbc(user.orgId)
  }

  @Get('rfm-distribution')
  rfm(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getRfmDistribution(user.orgId)
  }

  @Get('churn-risk')
  churn(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getChurnRisk(user.orgId)
  }

  @Get('churn-risk/customers')
  churnList(
    @ReqUser() user: ReqUserPayload,
    @Query('limit') limit?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getChurnRiskCustomers(user.orgId, limit ? Number(limit) : undefined)
  }

  @Get('top-customers')
  top(
    @ReqUser() user: ReqUserPayload,
    @Query('limit') limit?: string,
    @Query('sort')  sort?:  string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const sortV = sort === 'rfm' || sort === 'monetary' ? sort : 'ltv'
    return this.svc.getTopCustomers(user.orgId, {
      limit: limit ? Number(limit) : undefined,
      sort:  sortV as 'ltv' | 'rfm' | 'monetary',
    })
  }

  // ── Segments CRUD ───────────────────────────────────────────────────────

  @Get('segments')
  listSegments(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listSegments(user.orgId)
  }

  @Post('segments')
  @HttpCode(HttpStatus.CREATED)
  createSegment(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<CustomerSegment>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createSegment(user.orgId, body)
  }

  @Patch('segments/:id')
  updateSegment(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<CustomerSegment>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateSegment(user.orgId, id, body)
  }

  @Delete('segments/:id')
  @HttpCode(HttpStatus.OK)
  deleteSegment(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteSegment(user.orgId, id)
  }

  /** POST /customer-hub/segments/:id/compute → avalia rules e popula
   * customer_segment_members. */
  @Post('segments/:id/compute')
  @HttpCode(HttpStatus.OK)
  computeSegment(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.computeSegment(user.orgId, id)
  }

  /** POST /customer-hub/segments/preview { rules } → preview ao vivo da
   * UI: conta clientes que casariam SEM persistir membros. */
  @Post('segments/preview')
  @HttpCode(HttpStatus.OK)
  previewSegment(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { rules: SegmentRule[] },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.rules)) throw new BadRequestException('rules array obrigatório')
    return this.evaluator.matchCount(user.orgId, body.rules).then(count => ({ count }))
  }

  @Get('segments/:id/customers')
  segmentCustomers(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listSegmentCustomers(user.orgId, id, {
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }
}
