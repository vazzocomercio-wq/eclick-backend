import { Body, Controller, Get, Post, UseGuards, BadRequestException } from '@nestjs/common'
import { MetaCapiService } from './meta-capi.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Config + teste do Conversions API. A emissão real acontece no
 * PaymentsService (no pedido pago). Aqui o lojista cola o Dataset/Pixel ID
 * e o token de CAPI da própria conta.
 */
@Controller('capi')
@UseGuards(SupabaseAuthGuard)
export class MetaCapiController {
  constructor(private readonly svc: MetaCapiService) {}

  @Get('config')
  getConfig(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getConfig(u.orgId)
  }

  @Post('config')
  setConfig(@ReqUser() u: ReqUserPayload, @Body() body: { dataset_id?: string; access_token?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.setConfig(u.orgId, u.id, body)
  }

  @Post('test')
  test(@ReqUser() u: ReqUserPayload, @Body() body: { test_event_code?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.sendTest(u.orgId, body?.test_event_code)
  }
}
