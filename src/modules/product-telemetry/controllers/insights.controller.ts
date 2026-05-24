import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { PlatformAdminGuard } from '../guards/platform-admin.guard'
import { InsightsService } from '../services/insights.service'
import { RollupService } from '../services/rollup.service'
import { EngagementService } from '../services/engagement.service'
import { InsightsAiService } from '../services/insights-ai.service'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const brtToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const brtMinus = (days: number) =>
  new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })

/**
 * Leitura do dashboard /insights — visão de founder, cross-org.
 * SupabaseAuthGuard autentica (seta reqUser) e DEVE vir antes do
 * PlatformAdminGuard, que restringe à equipe e-Click lendo reqUser.id.
 */
@Controller('insights')
@UseGuards(SupabaseAuthGuard, PlatformAdminGuard)
export class InsightsController {
  constructor(
    private readonly insights:   InsightsService,
    private readonly rollup:     RollupService,
    private readonly engagement: EngagementService,
    private readonly aiInsights: InsightsAiService,
  ) {}

  /** Insights gerados por IA (lista; ?resolved=true|false filtra). */
  @Get('ai-insights')
  aiList(@Query('resolved') resolved?: string) {
    return this.insights.listAiInsights(resolved === 'true' ? true : resolved === 'false' ? false : undefined)
  }

  @Get('overview')
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    return this.insights.overview(from || brtMinus(6), to || brtToday())
  }

  @Get('modules/ranking')
  modulesRanking(@Query('period') period?: string) {
    return this.insights.modulesRanking(clamp(Number(period) || 7, 1, 90))
  }

  @Get('usage-matrix')
  usageMatrix(@Query('period') period?: string) {
    return this.insights.usageMatrix(clamp(Number(period) || 7, 1, 90))
  }

  /** Força um rollup agora (botão "atualizar" do dashboard). */
  @Post('run-rollup')
  runRollup() {
    return this.rollup.runRollup()
  }

  /** Força o recálculo de engajamento agora. */
  @Post('run-engagement')
  runEngagement() {
    return this.engagement.runEngagement()
  }

  /** Força a geração de insights por IA agora (todas as orgs com uso relevante). */
  @Post('run-ai-insights')
  runAiInsights() {
    return this.aiInsights.generateAll()
  }
}
