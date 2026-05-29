import {
  Controller, Get, Post, Body, Param, Query, UseGuards, BadRequestException, NotFoundException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeCampaignsService } from './shopee-campaigns.service'
import { CampaignMarginService, MarginEvalInput } from './campaign-margin.service'
import { CampaignKind, CampaignStatus } from './shopee-campaigns.types'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F1.4 — Campaign Center (READ). F3.1 — gate de margem. */
@Controller('shopee/campaigns')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeCampaignsController {
  constructor(
    private readonly svc:    ShopeeCampaignsService,
    private readonly margin: CampaignMarginService,
  ) {}

  /** POST /shopee/campaigns/evaluate-margin — F3.1 gate de margem.
   *  Declarado ANTES de @Get(':id') não conflita (método POST), mas mantido
   *  no topo por clareza. */
  @Post('evaluate-margin')
  @RequirePermission('ads.view')
  evaluateMargin(
    @ReqUser() user: ReqUserPayload,
    @Body() body: MarginEvalInput,
  ) {
    if (!user.orgId)         throw new BadRequestException('orgId ausente')
    if (body?.price == null) throw new BadRequestException('price obrigatório')
    return this.margin.evaluate(user.orgId, body)
  }

  /** GET /shopee/campaigns?kind=voucher&status=active&limit=50&offset=0 */
  @Get()
  @RequirePermission('ads.view')
  async list(
    @ReqUser() user: ReqUserPayload,
    @Query('kind')   kindRaw?:   string,
    @Query('status') statusRaw?: string,
    @Query('limit')  limitRaw?:  string,
    @Query('offset') offsetRaw?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const kind:   CampaignKind   | null = isKind(kindRaw)     ? kindRaw   : null
    const status: CampaignStatus | null = isStatus(statusRaw) ? statusRaw : null
    return this.svc.list({
      orgId:  user.orgId,
      kind,
      status,
      limit:  clampInt(limitRaw,  50, 1, 200),
      offset: clampInt(offsetRaw, 0, 0),
    })
  }

  /** GET /shopee/campaigns/:id */
  @Get(':id')
  @RequirePermission('ads.view')
  async getById(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const card = await this.svc.getById(user.orgId, id)
    if (!card) throw new NotFoundException('campanha não encontrada')
    return card
  }
}

function isKind(s: string | undefined): s is CampaignKind {
  return s === 'voucher' || s === 'flash_sale' || s === 'ads'
}
function isStatus(s: string | undefined): s is CampaignStatus {
  return s === 'planned' || s === 'active' || s === 'paused' || s === 'ended' || s === 'cancelled'
}
function clampInt(raw: string | undefined, def: number, min: number, max?: number): number {
  if (raw == null) return def
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return def
  let out = Math.max(min, n)
  if (max != null) out = Math.min(max, out)
  return out
}
