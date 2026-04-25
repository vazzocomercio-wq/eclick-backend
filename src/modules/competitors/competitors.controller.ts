import { Controller, Get, Post, Delete, Body, Param, Query, Headers, HttpException, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { CompetitorsService, CreateCompetitorDto } from './competitors.service'
import { ScraperService } from '../scraper/scraper.service'

@Controller('competitors')
@UseGuards(SupabaseAuthGuard)
export class CompetitorsController {
  constructor(
    private readonly svc: CompetitorsService,
    private readonly scraper: ScraperService,
  ) {}

  private async resolveOrgId(auth: string | undefined): Promise<string> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    const { data, error } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user?.id ?? '')
      .single()
    if (error || !data) throw new HttpException('Organização não encontrada', 400)
    return data.organization_id as string
  }

  @Post()
  async create(
    @Headers('authorization') auth: string,
    @Body() body: CreateCompetitorDto,
  ) {
    console.log('[competitors.create] body:', body)
    const orgId = await this.resolveOrgId(auth)
    return this.svc.create(orgId, body)
  }

  @Get('preview')
  async preview(@Query('url') url: string) {
    if (!url) throw new BadRequestException('url é obrigatório')
    return this.scraper.scrapeProduct(url)
  }

  @Post('enrich-all')
  async enrichAll(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    // Fire and forget — return immediately
    this.svc.enrichAllCompetitors(orgId).catch(() => {})
    return { ok: true, message: 'Enriquecimento iniciado' }
  }

  // Must be before :id to avoid route shadowing
  @Get(':id/history')
  getHistory(@Param('id') id: string) {
    return this.svc.getHistory(id)
  }

  @Get(':id/refresh')
  async refresh(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.refresh(orgId, id)
  }

  @Get(':id')
  async getOne(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getOne(orgId, id)
  }

  @Get()
  async list(
    @Headers('authorization') auth: string,
    @Query('product_id') productId?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.list(orgId, productId)
  }

  @Delete(':id')
  async remove(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.remove(orgId, id)
  }
}
