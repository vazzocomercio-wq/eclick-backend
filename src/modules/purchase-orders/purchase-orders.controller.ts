import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { PurchaseOrdersService } from './purchase-orders.service'

@Controller('purchase-orders')
@UseGuards(SupabaseAuthGuard)
export class PurchaseOrdersController {
  constructor(private readonly svc: PurchaseOrdersService) {}

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

  // Must be declared before :id to avoid route conflict
  @Get('timeline')
  async getTimeline(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getTimeline(orgId)
  }

  @Get()
  async getOrders(
    @Headers('authorization') auth: string,
    @Query('status')      status?:      string,
    @Query('supplier_id') supplier_id?: string,
    @Query('date_from')   date_from?:   string,
    @Query('date_to')     date_to?:     string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getOrders(orgId, { status, supplier_id, date_from, date_to })
  }

  @Get(':id')
  async getOrder(@Headers('authorization') auth: string, @Param('id') id: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getOrder(orgId, id)
  }

  @Post()
  async createOrder(@Headers('authorization') auth: string, @Body() body: Record<string, unknown>) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createOrder(orgId, body as Parameters<typeof this.svc.createOrder>[1])
  }

  @Patch(':id/status')
  async updateStatus(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateStatus(orgId, id, status)
  }

  @Patch(':id/items/:itemId')
  async updateItem(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { quantity_received?: number; actual_arrival_date?: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateItem(orgId, id, itemId, body)
  }

  @Patch(':id')
  async updateOrder(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateOrder(orgId, id, body)
  }

  @Delete(':id')
  async deleteOrder(@Headers('authorization') auth: string, @Param('id') id: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.deleteOrder(orgId, id)
  }
}
