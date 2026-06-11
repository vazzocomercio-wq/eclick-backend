import {
  Controller, Get, Put, Post, Body, Param, Query, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CompositionService, InvoiceLine } from './composition.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Composição (kit operacional) — SKU composto de outros produtos.
 *  Venda do kit baixa componentes; estoque do kit = min(componente ÷ qtd). */
@Controller('composition')
@UseGuards(SupabaseAuthGuard)
export class CompositionController {
  constructor(private readonly svc: CompositionService) {}

  /** Lista todos os kits da org com componentes. */
  @Get()
  list(@ReqUser() user: ReqUserPayload) {
    return this.svc.listKits(this.orgOf(user))
  }

  /** Busca produtos pra montar composição (marca quem já é kit). */
  @Get('search-products')
  search(@ReqUser() user: ReqUserPayload, @Query('q') q?: string, @Query('limit') limit?: string) {
    return this.svc.searchProducts(this.orgOf(user), q ?? '', limit ? Number(limit) : undefined)
  }

  /** Composição de 1 produto (array vazio = não é kit). */
  @Get(':productId')
  get(@ReqUser() user: ReqUserPayload, @Param('productId') productId: string) {
    return this.svc.getComposition(this.orgOf(user), productId)
  }

  /** Define/substitui a composição. items vazio = remove (deixa de ser kit). */
  @Put(':productId')
  set(
    @ReqUser() user: ReqUserPayload,
    @Param('productId') productId: string,
    @Body() body: { items: Array<{ component_product_id: string; quantity: number }> },
  ) {
    return this.svc.setComposition(this.orgOf(user), productId, body?.items ?? [])
  }

  /** Explode linhas de invoice (kits → componentes) — usado pela emissão de
   *  NF-e e disponível pra preview na UI. Não altera nada. */
  @Post('explode-invoice-items')
  @HttpCode(HttpStatus.OK)
  explode(@ReqUser() user: ReqUserPayload, @Body() body: { items: InvoiceLine[] }) {
    return this.svc.explodeForInvoice(this.orgOf(user), body?.items ?? [])
  }

  private orgOf(user: ReqUserPayload): string {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return user.orgId
  }
}
