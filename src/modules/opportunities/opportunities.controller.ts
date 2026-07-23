import {
  Controller, Get, Post, Patch, Delete, Body, Query, Param, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { OpportunitiesService } from './opportunities.service'
import { ReviewFetcherService } from './review-fetcher.service'
import { PainMinerService } from './pain-miner.service'
import { PainStatus } from './opportunities.types'

interface ReqUserPayload { id: string; orgId: string | null }

/** Radar de Encaixe — acessórios 3D pra produtos de grande circulação. */
@Controller('opportunities')
@UseGuards(SupabaseAuthGuard)
export class OpportunitiesController {
  constructor(
    private readonly svc:     OpportunitiesService,
    private readonly fetcher: ReviewFetcherService,
    private readonly miner:   PainMinerService,
  ) {}

  /** GET /opportunities/hosts?status=ativo */
  @Get('hosts')
  hosts(@ReqUser() user: ReqUserPayload, @Query('status') status?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listHosts(user.orgId, status)
  }

  /** POST /opportunities/hosts { url } — adotar hospedeiro por URL/id de anúncio. */
  @Post('hosts')
  addHost(@ReqUser() user: ReqUserPayload, @Body() body: { url?: string; title?: string; notes?: string }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!body.url?.trim()) throw new BadRequestException('Informe a URL ou o id do anúncio')
    return this.svc.addHost(user.orgId, user.id ?? null, { url: body.url, title: body.title, notes: body.notes })
  }

  /** POST /opportunities/hosts/:id/fetch-reviews — puxar avaliações pro cache. */
  @Post('hosts/:id/fetch-reviews')
  fetchReviews(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.fetcher.fetchForHost(user.orgId, id)
  }

  /** POST /opportunities/hosts/:id/mine — minerar dores com IA. */
  @Post('hosts/:id/mine')
  mine(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.miner.mineForHost(user.orgId, id)
  }

  /** GET /opportunities/hosts/:id/pains */
  @Get('hosts/:id/pains')
  pains(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listPains(user.orgId, id)
  }

  /** GET /opportunities/hosts/:id/reviews?max_stars=4 — evidência bruta. */
  @Get('hosts/:id/reviews')
  reviews(@ReqUser() user: ReqUserPayload, @Param('id') id: string, @Query('max_stars') maxStars?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const ms = maxStars != null ? Number(maxStars) : undefined
    return this.svc.listReviews(user.orgId, id, Number.isFinite(ms) ? ms : undefined)
  }

  /** PATCH /opportunities/pains/:id { status } */
  @Patch('pains/:id')
  async patchPain(@ReqUser() user: ReqUserPayload, @Param('id') id: string, @Body() body: { status?: string }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const ok: PainStatus[] = ['nova', 'validando', 'descartada', 'virou_conceito']
    if (!body.status || !ok.includes(body.status as PainStatus)) {
      throw new BadRequestException(`status deve ser um de: ${ok.join(', ')}`)
    }
    await this.svc.setPainStatus(user.orgId, id, body.status as PainStatus)
    return { ok: true }
  }

  /** DELETE /opportunities/hosts/:id — arquivar (não apaga evidência). */
  @Delete('hosts/:id')
  async archive(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    await this.svc.archiveHost(user.orgId, id)
    return { ok: true }
  }
}
