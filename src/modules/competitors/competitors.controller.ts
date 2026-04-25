import { Controller, Get, Post, Delete, Body, Param, Query, Headers, HttpException, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { CompetitorsService, CreateCompetitorDto } from './competitors.service'

@Controller('competitors')
@UseGuards(SupabaseAuthGuard)
export class CompetitorsController {
  constructor(private readonly svc: CompetitorsService) {}

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
