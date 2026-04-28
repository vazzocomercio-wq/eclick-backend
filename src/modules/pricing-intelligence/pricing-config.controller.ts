import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import {
  PricingConfigService, SeasonalPeriod, UntouchableSeller,
} from './pricing-config.service'
import { PricingPresetsService, PresetName } from './pricing-presets.service'
import { PricingAuditService } from './pricing-audit.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('pricing')
@UseGuards(SupabaseAuthGuard)
export class PricingConfigController {
  constructor(
    private readonly cfg:     PricingConfigService,
    private readonly presets: PricingPresetsService,
    private readonly audit:   PricingAuditService,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────────

  @Get('config')
  getConfig(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.getOrCreate(user.orgId)
  }

  /** PATCH /pricing/config { path, value, reason? } — deep merge JSONB
   * via path notation (ex: "abc_strategies.A.min_margin_pct"). */
  @Patch('config')
  patchConfig(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { path: string; value: unknown; reason?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.path) throw new BadRequestException('path obrigatório')
    return this.cfg.patchPath(user.orgId, body.path, body.value, user.id, body.reason ?? null)
  }

  /** POST /pricing/config/preset { preset } — aplica conservador/
   * equilibrado/agressivo. */
  @Post('config/preset')
  @HttpCode(HttpStatus.OK)
  applyPreset(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { preset: PresetName },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.preset) throw new BadRequestException('preset obrigatório')
    return this.cfg.applyPreset(user.orgId, body.preset, user.id)
  }

  /** POST /pricing/config/reset — recria com defaults DB (DELETE+INSERT). */
  @Post('config/reset')
  @HttpCode(HttpStatus.OK)
  resetConfig(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.resetToDefaults(user.orgId, user.id)
  }

  /** GET /pricing/config/audit?limit=50 — últimas mudanças. */
  @Get('config/audit')
  getAudit(
    @ReqUser() user: ReqUserPayload,
    @Query('limit') limit?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.audit.list(user.orgId, limit ? Number(limit) : undefined)
  }

  /** GET /pricing/config/presets — lista nomes de presets. UI usa pra dropdown. */
  @Get('config/presets')
  listPresets() {
    return this.presets.list().map(name => ({ name, payload: this.presets.get(name) }))
  }

  // ── Sazonalidade ────────────────────────────────────────────────────────

  @Get('seasonal')
  listSeasonal(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.listSeasonal(user.orgId)
  }

  @Post('seasonal')
  @HttpCode(HttpStatus.CREATED)
  createSeasonal(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<SeasonalPeriod>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.createSeasonal(user.orgId, body)
  }

  @Patch('seasonal/:id')
  updateSeasonal(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<SeasonalPeriod>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.updateSeasonal(user.orgId, id, body)
  }

  @Delete('seasonal/:id')
  @HttpCode(HttpStatus.OK)
  deleteSeasonal(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.deleteSeasonal(user.orgId, id)
  }

  // ── Vendedores intocáveis ───────────────────────────────────────────────

  @Get('untouchable-sellers')
  listUntouchable(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.listUntouchable(user.orgId)
  }

  @Post('untouchable-sellers')
  @HttpCode(HttpStatus.CREATED)
  createUntouchable(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<UntouchableSeller>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.createUntouchable(user.orgId, body)
  }

  @Delete('untouchable-sellers/:id')
  @HttpCode(HttpStatus.OK)
  deleteUntouchable(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.cfg.deleteUntouchable(user.orgId, id)
  }
}
