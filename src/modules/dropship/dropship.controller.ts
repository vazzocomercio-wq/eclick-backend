import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import {
  DropshipService,
  CreateDropshipPartnerDto, UpdateDropshipPartnerDto,
  CreateAccountSupplierDto, UpdateAccountSupplierDto,
  CreatePartnerProductDto, UpdatePartnerProductDto,
  BulkImportDto,
  CreateReturnDto, UpdateReturnDto, ApproveReturnDto,
  CreateDisputeDto, UpdateDisputeDto, ResolveDisputeDto,
} from './dropship.service'

@Controller('dropship')
@UseGuards(SupabaseAuthGuard)
export class DropshipController {
  constructor(private readonly svc: DropshipService) {}

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

  // ── Partners ─────────────────────────────────────────────────────────────

  @Get('partners')
  async listPartners(
    @Headers('authorization') auth: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listPartners(orgId, { status, q })
  }

  @Get('partners/:id')
  async getPartner(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getPartner(orgId, id)
  }

  @Post('partners')
  async createPartner(
    @Headers('authorization') auth: string,
    @Body() dto: CreateDropshipPartnerDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createPartner(orgId, dto)
  }

  @Patch('partners/:id')
  async updatePartner(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateDropshipPartnerDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updatePartner(orgId, id, dto)
  }

  @Delete('partners/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archivePartner(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.archivePartner(orgId, id)
  }

  // ── Account-Suppliers ────────────────────────────────────────────────────

  @Get('connected-accounts')
  async listConnectedAccounts(
    @Headers('authorization') auth: string,
    @Query('marketplace') marketplace: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listConnectedAccounts(orgId, marketplace)
  }

  @Get('account-suppliers')
  async listAccountSuppliers(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('marketplace') marketplace?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listAccountSuppliers(orgId, { supplier_id, marketplace })
  }

  @Post('account-suppliers')
  async createAccountSupplier(
    @Headers('authorization') auth: string,
    @Body() dto: CreateAccountSupplierDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createAccountSupplier(orgId, dto)
  }

  @Patch('account-suppliers/:id')
  async updateAccountSupplier(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateAccountSupplierDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateAccountSupplier(orgId, id, dto)
  }

  @Delete('account-suppliers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkAccountSupplier(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.unlinkAccountSupplier(orgId, id)
  }

  // ── Partner Products (catálogo dropship) ──────────────────────────────────

  @Get('partner-products')
  async listPartnerProducts(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('master_sku') master_sku?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listPartnerProducts(orgId, { supplier_id, status, q, master_sku })
  }

  @Get('partner-products/:id')
  async getPartnerProduct(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getPartnerProduct(orgId, id)
  }

  @Post('partner-products')
  async createPartnerProduct(
    @Headers('authorization') auth: string,
    @Body() dto: CreatePartnerProductDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createPartnerProduct(orgId, dto)
  }

  @Patch('partner-products/:id')
  async updatePartnerProduct(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdatePartnerProductDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updatePartnerProduct(orgId, id, dto)
  }

  @Delete('partner-products/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archivePartnerProduct(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.archivePartnerProduct(orgId, id)
  }

  @Get('partner-products/:id/cost-history')
  async listCostHistory(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listCostHistory(orgId, id)
  }

  // ── Sync logs ──────────────────────────────────────────────────────────────

  @Get('sync-logs')
  async listSyncLogs(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('status') status?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listSyncLogs(orgId, { supplier_id, status })
  }

  @Get('sync-logs/:id')
  async getSyncLog(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getSyncLog(orgId, id)
  }

  // ── Bulk import (planilha pré-parseada no client) ─────────────────────────

  @Post('partner-products/bulk-import')
  async bulkImport(
    @Headers('authorization') auth: string,
    @Body() dto: BulkImportDto,
  ) {
    // Resolve userId (pra registrar triggered_by no log) + orgId
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    const userId = user?.id ?? null
    const orgId = await this.resolveOrgId(auth)
    return this.svc.bulkImportPartnerProducts(orgId, dto, userId)
  }

  // ── Orders identification (Sprint 3) ──────────────────────────────────────

  @Get('orders')
  async listOrders(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('status') status?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
    @Query('q') q?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listDropshipOrders(orgId, { supplier_id, status, date_from, date_to, q })
  }

  @Get('orders/:id')
  async getOrder(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getDropshipOrder(orgId, id)
  }

  @Post('orders/identify')
  async forceIdentify(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.identifyDropshipOrders(orgId)
  }

  @Post('orders/:id/hold')
  async hold(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.holdDropshipOrder(orgId, id, body.reason)
  }

  @Post('orders/:id/release')
  async release(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.releaseDropshipOrder(orgId, id)
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  @Get('dashboard')
  async dashboard(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getDashboard(orgId)
  }

  @Get('today')
  async today(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getTodayOrders(orgId)
  }

  // ── OC (Sprint 4) ──────────────────────────────────────────────────────────

  @Get('oc')
  async listOCs(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('status') status?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listOCs(orgId, { supplier_id, status, date_from, date_to })
  }

  @Get('oc/preview')
  async previewOCs(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.previewOCs(orgId)
  }

  @Get('oc/:id')
  async getOC(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getOC(orgId, id)
  }

  @Post('oc/generate')
  async generateOCs(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.generateDailyOCs(orgId)
  }

  @Post('oc/:id/cancel')
  async cancelOC(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.cancelOC(orgId, id, body.reason)
  }

  // ── Portal envio (auth) ────────────────────────────────────────────────────

  @Post('oc/:id/send')
  async sendToPartner(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.sendOCToPartner(orgId, id)
  }

  @Get('oc/:id/notifications')
  async listOCNotifications(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listNotifications(orgId, id)
  }

  // ── Returns (Sprint 8) ────────────────────────────────────────────────────

  @Get('returns')
  async listReturns(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('status') status?: string,
    @Query('marketplace') marketplace?: string,
    @Query('return_type') return_type?: string,
    @Query('q') q?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listReturns(orgId, { supplier_id, status, marketplace, return_type, q })
  }

  @Get('returns/:id')
  async getReturn(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getReturn(orgId, id)
  }

  @Post('returns')
  async createReturn(
    @Headers('authorization') auth: string,
    @Body() dto: CreateReturnDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createReturn(orgId, dto)
  }

  @Patch('returns/:id')
  async updateReturn(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateReturnDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateReturn(orgId, id, dto)
  }

  @Post('returns/:id/approve')
  async approveReturn(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: ApproveReturnDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.approveReturn(orgId, id, dto)
  }

  @Post('returns/:id/reject')
  async rejectReturn(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.rejectReturn(orgId, id, body.reason)
  }

  // ── Credits (Sprint 9) ────────────────────────────────────────────────────

  @Get('credits')
  async listCredits(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('status') status?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listCredits(orgId, { supplier_id, status })
  }

  @Get('partners/:supplierId/credits-balance')
  async creditsBalance(
    @Headers('authorization') auth: string,
    @Param('supplierId') supplierId: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    const balance = await this.svc.getPendingCreditsBalance(orgId, supplierId)
    return { supplier_id: supplierId, pending_credits_balance: balance }
  }

  // ── Disputes (Sprint 10) ──────────────────────────────────────────────────

  @Get('disputes')
  async listDisputes(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('status') status?: string,
    @Query('dispute_type') dispute_type?: string,
    @Query('claimed_by') claimed_by?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listDisputes(orgId, { supplier_id, status, dispute_type, claimed_by })
  }

  @Get('disputes/:id')
  async getDispute(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getDispute(orgId, id)
  }

  @Post('disputes')
  async createDispute(
    @Headers('authorization') auth: string,
    @Body() dto: CreateDisputeDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    return this.svc.createDispute(orgId, user?.id ?? null, dto)
  }

  @Patch('disputes/:id')
  async updateDispute(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateDisputeDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateDispute(orgId, id, dto)
  }

  @Post('disputes/:id/resolve')
  async resolveDispute(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    return this.svc.resolveDispute(orgId, user?.id ?? null, id, dto)
  }

  // ── Scores (Sprint 11) ────────────────────────────────────────────────────

  @Get('partners/scores')
  async listScores(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listPartnerScores(orgId)
  }

  @Get('partners/:supplierId/score-history')
  async scoreHistory(
    @Headers('authorization') auth: string,
    @Param('supplierId') supplierId: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getPartnerScoreHistory(orgId, supplierId)
  }

  @Post('partners/scores/recalculate')
  async recalculateScores(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.recalculateAllScores(orgId)
  }

  // ── Divergências (Sprint 12) ──────────────────────────────────────────────

  @Get('divergences')
  async listDivergences(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('divergence_type') divergence_type?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listDivergences(orgId, { supplier_id, status, severity, divergence_type })
  }

  @Post('divergences/scan')
  async scanDivergences(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.scanDivergences(orgId)
  }

  @Post('divergences/:id/acknowledge')
  async ackDivergence(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    return this.svc.acknowledgeDivergence(orgId, user?.id ?? null, id)
  }

  @Post('divergences/:id/resolve')
  async resolveDivergence(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { notes: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    return this.svc.resolveDivergence(orgId, user?.id ?? null, id, body.notes)
  }

  @Post('divergences/:id/ignore')
  async ignoreDivergence(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    return this.svc.ignoreDivergence(orgId, user?.id ?? null, id, body.reason)
  }

  // ── Copiloto Dropship (Sprint 12) ─────────────────────────────────────────

  @Post('copilot/message')
  async copilotMessage(
    @Headers('authorization') auth: string,
    @Body() body: { message: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.copilotMessage(orgId, body.message)
  }
}
