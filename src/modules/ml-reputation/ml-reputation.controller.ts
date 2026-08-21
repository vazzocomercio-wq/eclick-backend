import {
  BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
import { MlReputationService } from './ml-reputation.service'
import type { SimulationInput } from './ml-reputation.types'

interface AuthUser { id: string; orgId: string | null }

function parseSellerId(raw: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new BadRequestException('seller_id inválido')
  return n
}

/**
 * Módulo de Reputação ML — central de prevenção.
 *
 * Toda rota resolve a org pelo JWT (@ReqUser) e toda rota por conta passa
 * por assertAccountInOrg no service: uma org nunca enxerga conta de outra.
 * Rotas literais antes das paramétricas (path-to-regexp v6).
 */
@Controller('ml-reputation')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class MlReputationController {
  constructor(private readonly reputation: MlReputationService) {}

  /** GET /ml-reputation/dashboard — resumo + todas as contas (leitura do cache, sem recálculo). */
  @Get('dashboard')
  @RequirePermission('orders.view')
  async dashboard(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.reputation.getDashboard(user.orgId)
  }

  /** GET /ml-reputation/rules — conjuntos de regras (vigente, futura e anteriores). */
  @Get('rules')
  @RequirePermission('orders.view')
  async rules(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return { rules: await this.reputation.listRules() }
  }

  /** GET /ml-reputation/events?seller_id=&limit= — eventos relevantes (troca de faixa/período, risco). */
  @Get('events')
  @RequirePermission('orders.view')
  async events(
    @ReqUser() user: AuthUser,
    @Query('seller_id') sellerIdQuery?: string,
    @Query('limit') limitQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const sellerId = sellerIdQuery ? parseSellerId(sellerIdQuery) : null
    const limit = limitQuery ? Number(limitQuery) : 50
    return { events: await this.reputation.getEvents(user.orgId, sellerId, Number.isFinite(limit) ? limit : 50) }
  }

  /** POST /ml-reputation/recalculate — recalcula todas as contas da org (sync oficial opcional). */
  @Post('recalculate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.view')
  async recalculateAll(@ReqUser() user: AuthUser, @Body() body?: { sync_official?: boolean }) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const accounts = await this.reputation.recalculateAll(user.orgId, { reason: 'manual', syncOfficial: body?.sync_official !== false })
    return { accounts }
  }

  /** GET /ml-reputation/accounts/:sellerId — detalhe de uma conta (cache). */
  @Get('accounts/:sellerId')
  @RequirePermission('orders.view')
  async account(@ReqUser() user: AuthUser, @Param('sellerId') sellerIdParam: string) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.reputation.getAccount(user.orgId, parseSellerId(sellerIdParam))
  }

  /** GET /ml-reputation/accounts/:sellerId/history?days=30 — snapshots diários (local + oficial). */
  @Get('accounts/:sellerId/history')
  @RequirePermission('orders.view')
  async history(
    @ReqUser() user: AuthUser,
    @Param('sellerId') sellerIdParam: string,
    @Query('days') daysQuery?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const sellerId = parseSellerId(sellerIdParam)
    const days = Math.min(730, Math.max(1, Number(daysQuery) || 30))
    return { seller_id: sellerId, days, history: await this.reputation.getHistory(user.orgId, sellerId, days) }
  }

  /** POST /ml-reputation/accounts/:sellerId/recalculate — recálculo imediato (botão "Atualizar"). */
  @Post('accounts/:sellerId/recalculate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.view')
  async recalculate(
    @ReqUser() user: AuthUser,
    @Param('sellerId') sellerIdParam: string,
    @Body() body?: { sync_official?: boolean; backfill?: boolean },
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.reputation.recalculate(user.orgId, parseSellerId(sellerIdParam), {
      reason:       'manual',
      syncOfficial: body?.sync_official !== false,
      backfill:     body?.backfill === true,
    })
  }

  /** POST /ml-reputation/accounts/:sellerId/simulate — "e se" (só visual, nada é gravado). */
  @Post('accounts/:sellerId/simulate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.view')
  async simulate(
    @ReqUser() user: AuthUser,
    @Param('sellerId') sellerIdParam: string,
    @Body() body: SimulationInput & { rule_set?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const sim: SimulationInput = {
      extraOccurrences:    body?.extraOccurrences ?? {},
      extraSales:          body?.extraSales ?? 0,
      occurrencesAddSales: body?.occurrencesAddSales ?? true,
    }
    return this.reputation.simulate(user.orgId, parseSellerId(sellerIdParam), sim, body?.rule_set)
  }
}
