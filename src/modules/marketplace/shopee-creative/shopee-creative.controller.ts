import {
  Controller, Post, Body, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeCreativePublisherService } from './shopee-creative.service'
import { ShopeeDraftListing } from './shopee-creative.types'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F1.7 + Fase F — IA Criativo Shopee. Guard de pré-publicação + publish. */
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

  /** POST /shopee/creative/publish
   *  Body: rascunho (com product_id) + opts { dry_run, delete_after }.
   *  Esteira IA Criativo → add_item. ⚠️ cria anúncio REAL (review Shopee).
   *  dry_run só monta o payload; delete_after cria e remove (teste ao vivo). */
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  async publish(
    @ReqUser() user: ReqUserPayload,
    @Body() body: ShopeeDraftListing & { dry_run?: boolean; delete_after?: boolean },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.product_id) throw new BadRequestException('product_id obrigatório')
    return this.svc.publish(user.orgId, body, { dryRun: body.dry_run, deleteAfter: body.delete_after })
  }
}
