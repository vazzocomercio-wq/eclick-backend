import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { MultiplierService } from './multiplier.service'
import { MultiplierTarget, MultiplierPayload } from './multiplier.types'

interface ReqUserPayload { id: string; orgId: string | null }

/** Multiplicação de Anúncios — copiar produto/anúncio pra outro canal.
 *  Fila revisável (multiplier_drafts) + publish via publicadores existentes. */
@Controller('multiplier')
@UseGuards(SupabaseAuthGuard)
export class MultiplierController {
  constructor(private readonly svc: MultiplierService) {}

  /** Destinos disponíveis (lojas Shopee conectadas, TikTok, loja própria). */
  @Get('targets')
  targets(@ReqUser() user: ReqUserPayload) {
    return this.svc.getTargets(this.orgOf(user))
  }

  /** Produtos com anúncio em ≥1 canal e SEM anúncio no destino. */
  @Get('candidates')
  candidates(
    @ReqUser() user: ReqUserPayload,
    @Query('target') target: string,
    @Query('account_id') accountId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!target) throw new BadRequestException('target obrigatório (shopee | tiktok_shop | storefront)')
    return this.svc.listCandidates(this.orgOf(user), {
      target:    target as MultiplierTarget,
      accountId: accountId ?? null,
      q:         q ?? null,
      limit:     limit ? Number(limit) : undefined,
      offset:    offset ? Number(offset) : undefined,
    })
  }

  @Get('drafts')
  drafts(
    @ReqUser() user: ReqUserPayload,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.svc.listDrafts(this.orgOf(user), {
      status: status ?? null,
      limit:  limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  /** Cria a proposta de multiplicação (payload já adaptado ao destino). */
  @Post('drafts')
  createDraft(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      product_id: string
      target_platform: MultiplierTarget
      target_account_id?: string | null
      source_listing_id?: string | null
    },
  ) {
    return this.svc.createDraft(this.orgOf(user), user.id, body)
  }

  /** Edita a proposta (título/descrição/preço/fotos/categoria/estoque). */
  @Patch('drafts/:id')
  updateDraft(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<MultiplierPayload>,
  ) {
    return this.svc.updateDraft(this.orgOf(user), id, body)
  }

  /** Publica de fato no canal destino. ⚠️ cria anúncio REAL. */
  @Post('drafts/:id/publish')
  @HttpCode(HttpStatus.OK)
  publish(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    return this.svc.publishDraft(this.orgOf(user), user.id, id)
  }

  @Post('drafts/:id/discard')
  @HttpCode(HttpStatus.OK)
  discard(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    return this.svc.discardDraft(this.orgOf(user), id)
  }

  private orgOf(user: ReqUserPayload): string {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return user.orgId
  }
}
