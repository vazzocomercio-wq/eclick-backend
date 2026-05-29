import {
  Controller, Post, Body, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeCreativePublisherService } from './shopee-creative.service'
import { ShopeeDraftListing } from './shopee-creative.types'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F1.7 — IA Criativo Shopee. Guard de pré-publicação (dry-run score). */
@Controller('shopee/creative')
@UseGuards(SupabaseAuthGuard)
export class ShopeeCreativeController {
  constructor(private readonly svc: ShopeeCreativePublisherService) {}

  /** POST /shopee/creative/evaluate
   *  Body: rascunho do anúncio. Retorna score + ready + blockers/warnings.
   *  Não publica nada — só avalia. */
  @Post('evaluate')
  evaluate(
    @ReqUser() user: ReqUserPayload,
    @Body() body: ShopeeDraftListing,
  ) {
    if (!user.orgId)       throw new BadRequestException('orgId ausente')
    if (body?.shop_id == null) throw new BadRequestException('shop_id obrigatório')
    return this.svc.evaluateDraft(body)
  }
}
