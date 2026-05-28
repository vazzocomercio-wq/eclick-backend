import {
  Controller, Get, Post, Param, Body, Query,
  UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
import { MlClaimsService } from './services/ml-claims.service'
import { MlClaimRemovalService } from './services/ml-claim-removal.service'
import { MlReputationService } from './services/ml-reputation.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('intelligence/ml')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class MlVerticalController {
  constructor(
    private readonly claims:        MlClaimsService,
    private readonly claimRemovals: MlClaimRemovalService,
    private readonly reputation:    MlReputationService,
  ) {}

  // ── Reputação ──────────────────────────────────────────────────────────

  @Get('reputation/latest')
  @RequirePermission('orders.view')
  reputationLatest(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.reputation.getLatestForOrg(u.orgId)
  }

  @Get('reputation/history')
  @RequirePermission('orders.view')
  reputationHistory(@ReqUser() u: ReqUserPayload, @Query('days') days?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    const d = days ? Math.min(180, Math.max(1, parseInt(days, 10) || 30)) : 30
    return this.reputation.getHistoryForOrg(u.orgId, d)
  }

  // ── Claims ─────────────────────────────────────────────────────────────

  @Get('claims')
  @RequirePermission('orders.view')
  listClaims(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('stage')  stage?: string,
    @Query('days')   days?: string,
    @Query('limit')  limit?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.claims.listForOrg(u.orgId, {
      status,
      stage,
      days:  days  ? parseInt(days, 10)  : undefined,
      limit: limit ? Math.min(500, Math.max(1, parseInt(limit, 10) || 100)) : undefined,
    })
  }

  @Get('claims/:id')
  @RequirePermission('orders.view')
  detailClaim(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.claims.findOne(u.orgId, id)
  }

  // ── Candidatos a exclusão de reclamação ────────────────────────────────

  @Get('claim-removals')
  @RequirePermission('orders.view')
  listRemovals(
    @ReqUser() u: ReqUserPayload,
    @Query('status')     status?: string,
    @Query('confidence') confidence?: string,
    @Query('limit')      limit?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.claimRemovals.listForOrg(u.orgId, {
      status,
      confidence,
      limit: limit ? Math.min(500, Math.max(1, parseInt(limit, 10) || 100)) : undefined,
    })
  }

  @Get('claim-removals/:id')
  @RequirePermission('orders.view')
  detailRemoval(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.claimRemovals.findOne(u.orgId, id)
  }

  @Post('claim-removals/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.update_status')
  dismissRemoval(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.claimRemovals.dismiss(u.orgId, id, u.id)
  }

  @Post('claim-removals/:id/proceed')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.update_status')
  proceedRemoval(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() _body: { notes?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.claimRemovals.markRequested(u.orgId, id)
  }

  @Post('claim-removals/:id/regenerate-text')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.view')
  regenerateRemovalText(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.claimRemovals.regenerateRequestText(u.orgId, id)
  }
}
