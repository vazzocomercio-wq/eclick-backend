import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RadarCompetitorsService } from './radar-competitors.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface AuthUser {
  id: string
  orgId: string | null
}

/**
 * e-Click Radar IA — Concorrentes Vinculados (C3).
 * CRUD de vínculos + comparação anúncio × concorrentes + insight de IA.
 * A coleta de visitas roda no eclick-workers.
 */
@Controller('radar/competitors')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class RadarCompetitorsController {
  constructor(private readonly svc: RadarCompetitorsService) {}

  /** Tela de gestão — produtos monitorados (com ≥1 vínculo). */
  @Get('products')
  @RequirePermission('products.view')
  listProducts(@ReqUser() user: AuthUser) {
    return this.svc.listMonitoredProducts(this.org(user))
  }

  /** Comparação — nosso anúncio vs concorrentes vinculados de um produto. */
  @Get('products/:productId')
  @RequirePermission('products.view')
  getComparison(@ReqUser() user: AuthUser, @Param('productId') productId: string) {
    return this.svc.getComparison(this.org(user), productId)
  }

  /** Insight de IA — leitura acionável dos movimentos dos concorrentes. */
  @Get('products/:productId/insight')
  @RequirePermission('products.view')
  getInsight(@ReqUser() user: AuthUser, @Param('productId') productId: string) {
    return this.svc.getInsight(this.org(user), productId)
  }

  /** Cria um vínculo produto ↔ anúncio concorrente. */
  @Post('links')
  @RequirePermission('products.update')
  createLink(
    @ReqUser() user: AuthUser,
    @Body() body: { product_id?: string; url?: string; item_id?: string; label?: string; current_price?: number },
  ) {
    return this.svc.createLink(this.org(user), user.id, body)
  }

  /** Atualiza preço / apelido / status de um vínculo. */
  @Patch('links/:id')
  @RequirePermission('products.update')
  updateLink(
    @ReqUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { current_price?: number; label?: string; status?: string },
  ) {
    return this.svc.updateLink(this.org(user), id, body)
  }

  /** Remove um vínculo. */
  @Delete('links/:id')
  @RequirePermission('products.update')
  deleteLink(@ReqUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.deleteLink(this.org(user), id)
  }

  private org(user: AuthUser): string {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return user.orgId
  }
}
