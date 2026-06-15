import {
  Controller, Get, Post, Query, Body, UseGuards, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { ChannelTakeReconcileService } from './channel-take-reconcile.service'
import { Channel } from '../channel-settings/channel-settings.service'

/** Reconciliação take estimado × real (escrow). Mês civil. */
@Controller('financeiro/reconcile')
@UseGuards(SupabaseAuthGuard)
export class ChannelTakeReconcileController {
  constructor(private readonly svc: ChannelTakeReconcileService) {}

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

  /** Último resultado de reconciliação persistido pro canal. */
  @Get()
  async latest(
    @Headers('authorization') auth: string,
    @Query('channel') channel?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getLatest(orgId, (channel as Channel) ?? 'shopee')
  }

  /** Roda a reconciliação on-demand (canal/mês). Mês default = mês anterior. */
  @Post('run')
  async run(
    @Headers('authorization') auth: string,
    @Body() body: { channel?: string; month?: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.reconcile(orgId, (body?.channel as Channel) ?? 'shopee', body?.month)
  }
}
