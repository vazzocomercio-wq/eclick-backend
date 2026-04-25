import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common'
import { AiUsageService } from './ai-usage.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'

@Controller('ai-usage')
export class AiUsageController {
  constructor(private readonly svc: AiUsageService) {}

  // POST /ai-usage — called server-side by Next.js route (no user auth needed here,
  // but protected by SupabaseAuthGuard so callers must pass a valid JWT)
  @Post()
  @UseGuards(SupabaseAuthGuard)
  log(@Body() body: {
    provider: string
    model: string
    feature?: string
    tokens_input: number
    tokens_output: number
    tokens_total: number
    cost_usd: number
  }) {
    return this.svc.logUsage({
      provider:       body.provider,
      model:          body.model,
      feature:        body.feature ?? 'unknown',
      tokens_input:   body.tokens_input  ?? 0,
      tokens_output:  body.tokens_output ?? 0,
      tokens_total:   body.tokens_total  ?? 0,
      cost_usd:       body.cost_usd      ?? 0,
    })
  }

  // GET /ai-usage/summary — current month aggregated per provider
  @Get('summary')
  @UseGuards(SupabaseAuthGuard)
  summary() {
    return this.svc.getSummary()
  }

  // GET /ai-usage/last30days — daily cost per provider for chart
  @Get('last30days')
  @UseGuards(SupabaseAuthGuard)
  last30days() {
    return this.svc.getLast30Days()
  }
}
