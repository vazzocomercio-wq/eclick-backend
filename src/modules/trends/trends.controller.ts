import {
  Controller, Get, Post, Patch, Delete, Body, Query, Param, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { TrendsService } from './trends.service'
import { BuyDecision } from './trends.types'

interface ReqUserPayload { id: string; orgId: string | null }

/** Radar de Tendências de Produtos (Fase 1 — Mercado Livre). */
@Controller('trends')
@UseGuards(SupabaseAuthGuard)
export class TrendsController {
  constructor(private readonly svc: TrendsService) {}

  /** GET /trends/radar?decision=comprar&category=MLB1574&min_score=40&limit=50 */
  @Get('radar')
  radar(
    @ReqUser() user: ReqUserPayload,
    @Query('decision')  decision?: string,
    @Query('category')  category?: string,
    @Query('min_score') minScoreRaw?: string,
    @Query('limit')     limitRaw?: string,
    @Query('offset')    offsetRaw?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const dec = decision && ['comprar', 'observar', 'ignorar'].includes(decision)
      ? (decision as BuyDecision) : null
    return this.svc.radar({
      orgId:    user.orgId,
      decision: dec,
      category: category ?? null,
      minScore: minScoreRaw != null ? Number(minScoreRaw) : null,
      limit:    clampInt(limitRaw, 50, 1, 200),
      offset:   clampInt(offsetRaw, 0, 0),
    })
  }

  /** GET /trends/rising-searches?category=MLB1574 — keywords mais buscadas. */
  @Get('rising-searches')
  rising(@ReqUser() user: ReqUserPayload, @Query('category') category?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.risingSearches(user.orgId, category ?? null)
  }

  /** GET /trends/ml-categories?parent=MLB1574 — árvore de categorias (raízes ou filhos). */
  @Get('ml-categories')
  mlCategories(@ReqUser() user: ReqUserPayload, @Query('parent') parent?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listCategories(user.orgId, parent ?? null)
  }

  /** POST /trends/collect — dispara coleta + score agora (manual). */
  @Post('collect')
  collect(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.collectAndScore(user.orgId)
  }

  // ── watchlist ─────────────────────────────────────────────────────────────

  /** POST /trends/watchlist { product_id, decision, note? } */
  @Post('watchlist')
  watch(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { product_id: string; decision: string; note?: string },
  ) {
    if (!user.orgId)        throw new BadRequestException('orgId ausente')
    if (!body?.product_id)  throw new BadRequestException('product_id obrigatório')
    if (!body?.decision)    throw new BadRequestException('decision obrigatória')
    return this.svc.setWatch(user.orgId, body.product_id, body.decision, body.note ?? null, user.id)
  }

  /** DELETE /trends/watchlist/:productId */
  @Delete('watchlist/:productId')
  unwatch(@ReqUser() user: ReqUserPayload, @Param('productId') productId: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.removeWatch(user.orgId, productId)
  }

  // ── settings ──────────────────────────────────────────────────────────────

  @Get('settings')
  getSettings(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSettings(user.orgId)
  }

  /** PATCH /trends/settings { categories?, target_margin_pct?, auto_enabled? } */
  @Patch('settings')
  saveSettings(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { categories?: string[]; target_margin_pct?: number; auto_enabled?: boolean },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.saveSettings(user.orgId, body ?? {})
  }
}

function clampInt(raw: string | undefined, def: number, min: number, max?: number): number {
  if (raw == null) return def
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return def
  let out = Math.max(min, n)
  if (max != null) out = Math.min(max, out)
  return out
}
