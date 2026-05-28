import { Controller, Get, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { FullFulfillmentCardService } from './full-fulfillment-card.service'
import { FlexOpportunityCardService } from './flex-opportunity-card.service'
import { VisitsLowConvCardService } from './visits-low-conv-card.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface AuthUser { id: string; orgId: string | null }

/**
 * F11 Fase 2 — endpoints dos 3 cards executivos.
 *
 * Cada endpoint serve UM card. Sem agregador comum — evita fan-out que
 * derruba a página inteira quando 1 query falha. SWR/cliente paraleliza.
 *
 * Ordem das rotas segura (literais antes de qualquer :param).
 */
@Controller('executive/cards')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ExecutiveCardsController {
  constructor(
    private readonly full:   FullFulfillmentCardService,
    private readonly flex:   FlexOpportunityCardService,
    private readonly visits: VisitsLowConvCardService,
  ) {}

  /** GET /executive/cards/full-fulfillment — penetração FULL + stale. */
  @Get('full-fulfillment')
  @RequirePermission('orders.view')
  async fullFulfillment(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.full.getCard(user.orgId)
  }

  /** GET /executive/cards/flex-opportunity — items elegíveis sem adesão. */
  @Get('flex-opportunity')
  @RequirePermission('orders.view')
  async flexOpportunity(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.flex.getCard(user.orgId)
  }

  /** GET /executive/cards/visits-low-conv — muita visita pouca venda. */
  @Get('visits-low-conv')
  @RequirePermission('orders.view')
  async visitsLowConv(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.visits.getCard(user.orgId)
  }
}
