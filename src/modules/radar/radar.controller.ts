import { Controller, Get, Param, Query, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RadarService } from './radar.service'

interface AuthUser {
  id: string
  orgId: string | null
}

/**
 * e-Click Radar IA — endpoints read-only das telas do módulo (R4).
 * A coleta/escrita roda no eclick-workers; aqui é só leitura.
 */
@Controller('radar')
@UseGuards(SupabaseAuthGuard)
export class RadarController {
  constructor(private readonly radar: RadarService) {}

  /** Tela 1 — watchlist + agregados. ?status=ativo|pausado filtra. */
  @Get('products')
  listProducts(@ReqUser() user: AuthUser, @Query('status') status?: string) {
    return this.radar.listProducts(this.org(user), status)
  }

  /** Tela 1 — KPI strip. */
  @Get('summary')
  getSummary(@ReqUser() user: AuthUser) {
    return this.radar.getSummary(this.org(user))
  }

  /** Tela 1 — feed "o que mudou" (eventos da org inteira). */
  @Get('events')
  listEvents(@ReqUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.radar.listEvents(this.org(user), limit ? Number(limit) : undefined)
  }

  /** Status real do catálogo (price_to_win) dos itens próprios — telas de anúncios. */
  @Get('catalog-status')
  catalogStatus(@ReqUser() user: AuthUser) {
    return this.radar.getCatalogStatus(this.org(user))
  }

  /** Tela 2 — produto + ranking competitivo + dados de margem. */
  @Get('products/:id')
  getProduct(@ReqUser() user: AuthUser, @Param('id') id: string) {
    return this.radar.getProduct(this.org(user), id)
  }

  /** Tela 2 — séries de preço (Vazzo + top 4 concorrentes) e visitas. */
  @Get('products/:id/series')
  getSeries(@ReqUser() user: AuthUser, @Param('id') id: string) {
    return this.radar.getSeries(this.org(user), id)
  }

  /** Tela 2 — feed de eventos do produto. */
  @Get('products/:id/events')
  getProductEvents(@ReqUser() user: AuthUser, @Param('id') id: string) {
    return this.radar.getProductEvents(this.org(user), id)
  }

  private org(user: AuthUser): string {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return user.orgId
  }
}
