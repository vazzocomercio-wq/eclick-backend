import {
  Controller, Get, Post, Query, UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
import { ExecutiveDashboardService } from './executive-dashboard.service'
import { ExecutiveReputationService } from './executive-reputation.service'
import { ExecutiveLogisticsService } from './executive-logistics.service'
import { ExecutiveVisitsService } from './executive-visits.service'
import { ExecutiveAdsService } from './executive-ads.service'

interface AuthUser { id: string; orgId: string | null }

/**
 * F11 Executive Dashboard — endpoints E1.
 *
 * Ordem das rotas importa (path-to-regexp v6 — feedback_path_to_regexp_v6):
 * literais antes de catch-all `:id` se algum vier.
 */
@Controller('executive')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ExecutiveDashboardController {
  constructor(
    private readonly dashboard:  ExecutiveDashboardService,
    private readonly reputation: ExecutiveReputationService,
    private readonly logistics:  ExecutiveLogisticsService,
    private readonly visits:     ExecutiveVisitsService,
    private readonly ads:        ExecutiveAdsService,
  ) {}

  /**
   * GET /executive/dashboard
   * GET /executive/dashboard?fresh=sales   → refresca vendas antes de ler
   * GET /executive/dashboard?fresh=all     → refresh completo antes de ler
   *
   * Retorna 1 snapshot por seller conectado à org. UI multi-conta consome
   * o array e mostra seletor / agregado.
   */
  @Get('dashboard')
  @RequirePermission('orders.view')
  async getDashboard(
    @ReqUser() user: AuthUser,
    @Query('fresh') fresh?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const freshOpt = fresh === 'sales' || fresh === 'all' ? fresh : undefined
    const snapshots = await this.dashboard.getDashboardsForOrg(user.orgId, { fresh: freshOpt })
    return { snapshots }
  }

  /**
   * POST /executive/dashboard/refresh
   * POST /executive/dashboard/refresh?seller_id=123 → refresh só de 1 seller
   *
   * Trigger manual (botão "Atualizar agora" no UI). Síncrono — espera concluir.
   */
  @Post('dashboard/refresh')
  @RequirePermission('orders.view')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')

    if (sellerIdQuery) {
      const sellerId = Number(sellerIdQuery)
      if (!Number.isFinite(sellerId)) {
        throw new BadRequestException('seller_id inválido')
      }
      const result = await this.dashboard.refresh(user.orgId, sellerId)
      return { refreshed: [result] }
    }

    // Sem seller_id: refresh de todas as contas da org
    const snapshots = await this.dashboard.getDashboardsForOrg(user.orgId, { fresh: 'all' })
    return { refreshed_count: snapshots.length, snapshots }
  }

  /**
   * GET /executive/dashboard/refresh-logs?limit=50
   */
  @Get('dashboard/refresh-logs')
  @RequirePermission('orders.view')
  async refreshLogs(
    @ReqUser() user: AuthUser,
    @Query('limit') limitQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const limit = limitQuery ? Number(limitQuery) : 50
    const logs = await this.dashboard.getRefreshLogs(user.orgId, limit)
    return { logs }
  }

  // ── E2 Reputação ─────────────────────────────────────────────────────────

  /** GET /executive/reputation — current de todas as contas da org. */
  @Get('reputation')
  @RequirePermission('orders.view')
  async getReputation(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const snapshots = await this.reputation.getCurrentForOrg(user.orgId)
    return { snapshots }
  }

  /**
   * GET /executive/reputation/history?seller_id=X&days=90
   * Série temporal pra gráfico de evolução.
   */
  @Get('reputation/history')
  @RequirePermission('orders.view')
  async reputationHistory(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
    @Query('days')      daysQuery?:     string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!sellerIdQuery) throw new BadRequestException('seller_id obrigatório')
    const sellerId = Number(sellerIdQuery)
    if (!Number.isFinite(sellerId)) throw new BadRequestException('seller_id inválido')
    const days = Math.min(Math.max(daysQuery ? Number(daysQuery) : 90, 1), 365)
    const history = await this.reputation.getHistory(user.orgId, sellerId, days)
    return { seller_id: sellerId, days, history }
  }

  /**
   * POST /executive/reputation/sync                  — sync de todas as contas da org
   * POST /executive/reputation/sync?seller_id=X      — sync de 1 conta
   */
  @Post('reputation/sync')
  @RequirePermission('orders.view')
  @HttpCode(HttpStatus.OK)
  async syncReputation(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')

    if (sellerIdQuery) {
      const sellerId = Number(sellerIdQuery)
      if (!Number.isFinite(sellerId)) throw new BadRequestException('seller_id inválido')
      const snapshot = await this.reputation.syncReputation(user.orgId, sellerId)
      return { synced: [snapshot] }
    }

    // Sem seller_id: sync de todas
    const current = await this.reputation.getCurrentForOrg(user.orgId)
    const orgId   = user.orgId
    const synced  = await Promise.allSettled(
      current.map(c => this.reputation.syncReputation(orgId, c.seller_id)),
    )
    const ok = synced.filter(r => r.status === 'fulfilled').length
    return { synced_count: ok, total: current.length }
  }

  // ── E3 Logística ─────────────────────────────────────────────────────────

  /** GET /executive/logistics — summary de todas as contas. */
  @Get('logistics')
  @RequirePermission('orders.view')
  async getLogistics(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const summaries = await this.logistics.getSummaryForOrg(user.orgId)
    return { summaries }
  }

  /** GET /executive/logistics/delays?seller_id=X&limit=50 — atrasos abertos. */
  @Get('logistics/delays')
  @RequirePermission('orders.view')
  async listDelays(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
    @Query('limit')     limitQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const sellerId = sellerIdQuery ? Number(sellerIdQuery) : undefined
    if (sellerIdQuery && !Number.isFinite(sellerId)) throw new BadRequestException('seller_id inválido')
    const limit = limitQuery ? Number(limitQuery) : 50
    const delays = await this.logistics.listOpenDelays(user.orgId, sellerId, limit)
    return { delays }
  }

  /** GET /executive/logistics/flex/eligible?seller_id=X&limit=100 — items com has_flex=true. */
  @Get('logistics/flex/eligible')
  @RequirePermission('orders.view')
  async listFlexEligible(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
    @Query('limit')     limitQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!sellerIdQuery) throw new BadRequestException('seller_id obrigatório')
    const sellerId = Number(sellerIdQuery)
    if (!Number.isFinite(sellerId)) throw new BadRequestException('seller_id inválido')
    const limit = limitQuery ? Number(limitQuery) : 100
    const items = await this.logistics.listFlexEligible(user.orgId, sellerId, limit)
    return { seller_id: sellerId, items }
  }

  /**
   * POST /executive/logistics/scan?seller_id=X        — scan completo de 1 seller
   * POST /executive/logistics/scan?kind=delays        — só delays
   * POST /executive/logistics/scan?kind=flex          — só flex
   * POST /executive/logistics/scan?kind=summary       — só refresh do agregado
   */
  @Post('logistics/scan')
  @RequirePermission('orders.view')
  @HttpCode(HttpStatus.OK)
  async scan(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
    @Query('kind')      kind?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!sellerIdQuery) throw new BadRequestException('seller_id obrigatório')
    const sellerId = Number(sellerIdQuery)
    if (!Number.isFinite(sellerId)) throw new BadRequestException('seller_id inválido')

    const orgId = user.orgId
    if (kind === 'delays')   return { delays:  await this.logistics.scanDelays(orgId, sellerId) }
    if (kind === 'flex')     return { flex:    await this.logistics.scanFlex(orgId, sellerId) }
    if (kind === 'summary') {
      await this.logistics.refreshSummary(orgId, sellerId)
      return { summary: 'refreshed' }
    }

    // full scan (default)
    const delays = await this.logistics.scanDelays(orgId, sellerId)
    const flex   = await this.logistics.scanFlex(orgId, sellerId)
    await this.logistics.refreshSummary(orgId, sellerId)
    return { delays, flex }
  }

  // ── E4 Visitas + Conversão ───────────────────────────────────────────────

  /**
   * GET /executive/visits?seller_id=X&days=30
   * Histórico diário com visits + orders + conversion.
   */
  @Get('visits')
  @RequirePermission('products.view')
  async getVisits(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
    @Query('days')      daysQuery?:     string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!sellerIdQuery) throw new BadRequestException('seller_id obrigatório')
    const sellerId = Number(sellerIdQuery)
    if (!Number.isFinite(sellerId)) throw new BadRequestException('seller_id inválido')
    const days = Math.min(Math.max(daysQuery ? Number(daysQuery) : 30, 1), 90)
    const history = await this.visits.getDailyHistory(user.orgId, sellerId, days)
    return { seller_id: sellerId, days, history }
  }

  /**
   * POST /executive/visits/sync?seller_id=X&days=30  — manual
   * POST /executive/visits/sync                       — todas as contas, últimos 7d
   */
  @Post('visits/sync')
  @RequirePermission('products.view')
  @HttpCode(HttpStatus.OK)
  async syncVisits(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
    @Query('days')      daysQuery?:     string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const days = daysQuery ? Number(daysQuery) : 7

    if (sellerIdQuery) {
      const sellerId = Number(sellerIdQuery)
      if (!Number.isFinite(sellerId)) throw new BadRequestException('seller_id inválido')
      const r = await this.visits.syncRecent(user.orgId, sellerId, days)
      return { synced: [{ seller_id: sellerId, ...r }] }
    }

    // Sem seller_id: sync de todas as contas
    const reputation = await this.reputation.getCurrentForOrg(user.orgId)
    const orgId      = user.orgId
    const results    = await Promise.allSettled(
      reputation.map(r => this.visits.syncRecent(orgId, r.seller_id, days)),
    )
    const ok = results.filter(r => r.status === 'fulfilled').length
    return { synced_count: ok, total: reputation.length }
  }

  // ── E5 Ads Visibility ────────────────────────────────────────────────────

  /** GET /executive/ads — summary org-level (sem multi-conta — Ads é por advertiser, não seller). */
  @Get('ads')
  @RequirePermission('ads.view')
  async getAds(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const summary = await this.ads.getSummaryForOrg(user.orgId)
    return { summary }
  }

  /** GET /executive/ads/leaderboard?kind=winners|losers&limit=10 */
  @Get('ads/leaderboard')
  @RequirePermission('ads.view')
  async leaderboard(
    @ReqUser() user: AuthUser,
    @Query('kind')  kindQuery?: string,
    @Query('limit') limitQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const kind = kindQuery === 'losers' ? 'losers' : 'winners'
    const limit = limitQuery ? Number(limitQuery) : 10
    const campaigns = await this.ads.getLeaderboard(user.orgId, kind, limit)
    return { kind, campaigns }
  }

  /** GET /executive/ads/chart?days=30 — série temporal spend + revenue. */
  @Get('ads/chart')
  @RequirePermission('ads.view')
  async adsChart(
    @ReqUser() user: AuthUser,
    @Query('days') daysQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const days = Math.min(Math.max(daysQuery ? Number(daysQuery) : 30, 1), 90)
    const chart = await this.ads.getSpendVsRevenueChart(user.orgId, days)
    return { days, chart }
  }

  /** POST /executive/ads/refresh — manual (sem ML calls). */
  @Post('ads/refresh')
  @RequirePermission('ads.view')
  @HttpCode(HttpStatus.OK)
  async refreshAds(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const result = await this.ads.refreshSummary(user.orgId)
    return { refreshed: result }
  }
}
