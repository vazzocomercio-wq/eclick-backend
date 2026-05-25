import {
  Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { FulfillmentService } from './fulfillment.service'
import { FulfillmentReturnsService, type ReturnItemCondition } from './fulfillment-returns.service'
import { FulfillmentWaveService } from './fulfillment-wave.service'
import { FulfillmentAccountsService, type CompanyRole } from './fulfillment-accounts.service'
import { FulfillmentInvoicesService, type InvoiceKind, type InvoiceStatus, type InvoiceItem } from './fulfillment-invoices.service'
import { FulfillmentPackagingService, type PackagingKind, type PackagingKitItem } from './fulfillment-packaging.service'
import { FulfillmentFiscalService, type FiscalProvider, type FiscalEnvironment, type RegimeTributario } from './fulfillment-fiscal.service'
import type { SeedItem, SourceType, FulfillmentSettings, DamageSeverity, DamageResolution, OperatorRole } from './fulfillment.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * F12 Fulfillment — endpoints do operador + setup.
 * Todos exigem login (SupabaseAuthGuard) e são escopados por org.
 */
@Controller('fulfillment')
@UseGuards(SupabaseAuthGuard)
export class FulfillmentController {
  constructor(
    private readonly svc: FulfillmentService,
    private readonly returns: FulfillmentReturnsService,
    private readonly waves: FulfillmentWaveService,
    private readonly accounts: FulfillmentAccountsService,
    private readonly invoices: FulfillmentInvoicesService,
    private readonly packaging: FulfillmentPackagingService,
    private readonly fiscal: FulfillmentFiscalService,
  ) {}

  private org(u: ReqUserPayload): string {
    if (!u.orgId) throw new BadRequestException('Usuário sem organização.')
    return u.orgId
  }

  // ── Setup ───────────────────────────────────────────────────────────
  @Get('settings')
  getSettings(@ReqUser() u: ReqUserPayload) {
    return this.svc.getSettings(this.org(u))
  }

  @Put('settings')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: Partial<FulfillmentSettings>) {
    return this.svc.updateSettings(this.org(u), body ?? {})
  }

  @Get('warehouses')
  listWarehouses(@ReqUser() u: ReqUserPayload) {
    return this.svc.listWarehouses(this.org(u))
  }

  @Post('warehouses')
  createWarehouse(@ReqUser() u: ReqUserPayload, @Body() body: { name: string; code: string; address?: Record<string, unknown> }) {
    return this.svc.createWarehouse(this.org(u), body)
  }

  @Get('dashboard')
  dashboard(@ReqUser() u: ReqUserPayload, @Query('warehouse_id') warehouseId?: string) {
    return this.svc.dashboard(this.org(u), warehouseId)
  }

  // Painel tempo real "McDonald's" (Onda B)
  @Get('board')
  board(@ReqUser() u: ReqUserPayload, @Query('warehouse_id') warehouseId?: string) {
    return this.svc.board(this.org(u), warehouseId)
  }

  // Aguardando coleta — staging por empresa → conta (Onda C)
  @Get('collection')
  collection(@ReqUser() u: ReqUserPayload, @Query('warehouse_id') warehouseId?: string, @Query('days') days?: string) {
    return this.svc.collectionQueue(this.org(u), warehouseId, days ? Number(days) : undefined)
  }

  // ── NF-e (Onda D — preparação + validação de conferência fiscal) ─────
  @Get('orders/:foId/invoices')
  listInvoices(@ReqUser() u: ReqUserPayload, @Param('foId') foId: string) {
    return this.invoices.listForOrder(this.org(u), foId)
  }

  @Put('orders/:foId/invoices')
  upsertInvoice(@ReqUser() u: ReqUserPayload, @Param('foId') foId: string, @Body() body: {
    id?: string; companyId?: string | null; kind?: InvoiceKind; status?: InvoiceStatus
    number?: string | null; series?: string | null; accessKey?: string | null
    danfeUrl?: string | null; xmlUrl?: string | null; provider?: string | null; items?: InvoiceItem[]
  }) {
    return this.invoices.upsertForOrder(this.org(u), foId, body ?? {})
  }

  @Post('invoices/:id/validate')
  validateInvoice(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.invoices.validate(this.org(u), id)
  }

  @Delete('invoices/:id')
  removeInvoice(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.invoices.remove(this.org(u), id)
  }

  // ── Embalagens (Onda E — tipos + kits + sugestão) ────────────────────
  @Get('packaging/types')
  listPackagingTypes(@ReqUser() u: ReqUserPayload) {
    return this.packaging.listTypes(this.org(u))
  }
  @Post('packaging/types')
  createPackagingType(@ReqUser() u: ReqUserPayload, @Body() body: { name: string; kind?: PackagingKind; width_cm?: number | null; height_cm?: number | null; depth_cm?: number | null; weight_g?: number | null; cost_cents?: number | null; stock?: number | null }) {
    return this.packaging.createType(this.org(u), body)
  }
  @Patch('packaging/types/:id')
  updatePackagingType(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.packaging.updateType(this.org(u), id, body ?? {})
  }
  @Delete('packaging/types/:id')
  removePackagingType(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.packaging.removeType(this.org(u), id)
  }

  @Get('packaging/kits')
  listPackagingKits(@ReqUser() u: ReqUserPayload) {
    return this.packaging.listKits(this.org(u))
  }
  @Post('packaging/kits')
  createPackagingKit(@ReqUser() u: ReqUserPayload, @Body() body: { name: string; items?: PackagingKitItem[] }) {
    return this.packaging.createKit(this.org(u), body)
  }
  @Patch('packaging/kits/:id')
  updatePackagingKit(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { name?: string; items?: PackagingKitItem[]; is_active?: boolean }) {
    return this.packaging.updateKit(this.org(u), id, body ?? {})
  }
  @Delete('packaging/kits/:id')
  removePackagingKit(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.packaging.removeKit(this.org(u), id)
  }

  @Post('pack-tasks/:id/packaging')
  setPackaging(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { packagingTypeId?: string | null; packagingKitId?: string | null }) {
    return this.packaging.setPackaging(this.org(u), id, body ?? {})
  }

  @Get('orders/:foId/packaging-suggest')
  suggestPackaging(@ReqUser() u: ReqUserPayload, @Param('foId') foId: string) {
    return this.packaging.suggest(this.org(u), foId)
  }

  // ── Fiscal / Faturador F1 — config de NF-e por empresa + produto ─────
  @Get('fiscal/companies/:companyId')
  getCompanyFiscal(@ReqUser() u: ReqUserPayload, @Param('companyId') companyId: string) {
    return this.fiscal.getCompanyFiscal(this.org(u), companyId)
  }

  @Put('fiscal/companies/:companyId')
  upsertCompanyFiscal(@ReqUser() u: ReqUserPayload, @Param('companyId') companyId: string, @Body() body: {
    provider?: FiscalProvider | null; environment?: FiscalEnvironment; providerToken?: string | null
    providerCompanyRef?: string | null; inscricaoEstadual?: string | null; regimeTributario?: RegimeTributario | null
    cnae?: string | null; fiscalAddress?: Record<string, unknown>
    invoiceSalePct?: number; invoicePurchasePct?: number
    certificateStatus?: 'pending' | 'uploaded' | 'expired'; certificateExpiresAt?: string | null
  }) {
    return this.fiscal.upsertCompanyFiscal(this.org(u), u.id, companyId, body ?? {})
  }

  @Get('fiscal/companies/:companyId/readiness')
  fiscalReadiness(@ReqUser() u: ReqUserPayload, @Param('companyId') companyId: string) {
    return this.fiscal.readiness(this.org(u), companyId)
  }

  @Get('fiscal/products')
  listProductFiscal(@ReqUser() u: ReqUserPayload) {
    return this.fiscal.listProductFiscal(this.org(u))
  }

  @Put('fiscal/products/:productId')
  upsertProductFiscal(@ReqUser() u: ReqUserPayload, @Param('productId') productId: string, @Body() body: {
    ncm?: string | null; cest?: string | null; origem?: string | null
    cfop_sale?: string | null; cfop_transfer?: string | null; cst_csosn?: string | null
    unit?: string | null; tax_rate?: number | null
  }) {
    return this.fiscal.upsertProductFiscal(this.org(u), productId, body ?? {})
  }

  // ── Operadores + produtividade (Sprint 2) ────────────────────────────
  @Get('org-members')
  orgMembers(@ReqUser() u: ReqUserPayload) {
    return this.svc.listOrgMembers(this.org(u))
  }

  @Get('operators')
  operators(@ReqUser() u: ReqUserPayload, @Query('warehouse_id') warehouseId?: string) {
    return this.svc.listOperators(this.org(u), warehouseId)
  }

  @Post('operators')
  addOperator(@ReqUser() u: ReqUserPayload, @Body() body: { warehouseId: string; userId: string; role: OperatorRole }) {
    return this.svc.addOperator(this.org(u), u.id, body)
  }

  @Patch('operators/:id')
  updateOperator(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { role?: OperatorRole; is_active?: boolean }) {
    return this.svc.updateOperator(this.org(u), u.id, id, body ?? {})
  }

  @Delete('operators/:id')
  removeOperator(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.removeOperator(this.org(u), u.id, id)
  }

  @Get('productivity')
  productivity(@ReqUser() u: ReqUserPayload, @Query('days') days?: string, @Query('warehouse_id') warehouseId?: string) {
    return this.svc.productivity(this.org(u), { days: days ? Number(days) : undefined, warehouseId })
  }

  @Post('reconcile')
  reconcile(@ReqUser() u: ReqUserPayload) {
    return this.svc.reconcileOrg(this.org(u))
  }

  // ── Devoluções (Sprint 5) ────────────────────────────────────────────
  @Get('returns')
  listReturns(@ReqUser() u: ReqUserPayload, @Query('warehouse_id') warehouseId?: string) {
    return this.returns.list(this.org(u), warehouseId)
  }

  @Get('returns/:id')
  getReturn(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.returns.get(this.org(u), id)
  }

  @Post('returns')
  registerReturn(@ReqUser() u: ReqUserPayload, @Body() body: {
    warehouseId?: string; fulfillmentOrderId?: string; reference?: string
    customer?: Record<string, unknown>; reason?: string
    items?: Array<{ sku: string; productId?: string; qty: number; title?: string }>
  }) {
    return this.returns.register(this.org(u), u.id, body ?? {})
  }

  @Post('returns/:id/resolve')
  resolveReturn(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { resolutions: Array<{ sku: string; condition: ReturnItemCondition }> }) {
    if (!Array.isArray(body?.resolutions)) throw new BadRequestException('Informe as resoluções dos itens.')
    return this.returns.resolve(this.org(u), u.id, id, body.resolutions)
  }

  // ── Seed (ingestão de pedido → tarefas) ──────────────────────────────
  @Post('pick-tasks/seed')
  seed(@ReqUser() u: ReqUserPayload, @Body() body: {
    source: SourceType; warehouseId?: string; orderId?: string; externalOrderId?: string
    customer?: Record<string, unknown>; items?: SeedItem[]; channel?: string
  }) {
    if (!body?.source) throw new BadRequestException('Informe a origem do pedido (source).')
    return this.svc.seed(this.org(u), body)
  }

  // ── Picking ──────────────────────────────────────────────────────────
  @Get('pick-tasks/queue')
  pickQueue(@ReqUser() u: ReqUserPayload, @Query('warehouse_id') warehouseId?: string) {
    return this.svc.pickQueue(this.org(u), warehouseId)
  }

  @Post('pick-tasks/:id/scan-item')
  scanItem(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { code: string }) {
    if (!body?.code) throw new BadRequestException('Código bipado vazio.')
    return this.svc.scanItem(this.org(u), u.id, id, body.code)
  }

  @Post('pick-tasks/:id/complete')
  pickComplete(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.pickComplete(this.org(u), u.id, id)
  }

  @Post('pick-tasks/:id/block')
  pickBlock(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.pickBlock(this.org(u), u.id, id, body?.reason ?? '')
  }

  // ── Packing ──────────────────────────────────────────────────────────
  @Get('pack-tasks/queue')
  packQueue(@ReqUser() u: ReqUserPayload, @Query('warehouse_id') warehouseId?: string) {
    return this.svc.packQueue(this.org(u), warehouseId)
  }

  @Post('pack-tasks/:id/scan-order')
  packScanOrder(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { code: string }) {
    if (!body?.code) throw new BadRequestException('Código bipado vazio.')
    return this.svc.packScanOrder(this.org(u), u.id, id, body.code)
  }

  @Post('pack-tasks/:id/photo')
  packPhoto(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { imageBase64: string; mimeType?: string }) {
    if (!body?.imageBase64) throw new BadRequestException('Foto ausente.')
    return this.svc.packPhoto(this.org(u), u.id, id, body.imageBase64, body.mimeType)
  }

  @Post('pack-tasks/:id/complete')
  packComplete(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.packComplete(this.org(u), u.id, id)
  }

  // ── Avarias ──────────────────────────────────────────────────────────
  @Post('damage-reports')
  reportDamage(@ReqUser() u: ReqUserPayload, @Body() body: {
    warehouseId?: string; pickTaskId?: string; fulfillmentOrderId?: string
    sku: string; severity: DamageSeverity; description?: string; photosBase64?: string[]; resolution?: DamageResolution
  }) {
    if (!body?.sku || !body?.severity) throw new BadRequestException('SKU e severidade são obrigatórios.')
    return this.svc.reportDamage(this.org(u), u.id, body)
  }

  // ── Etiqueta ─────────────────────────────────────────────────────────
  @Post('shipment-labels/print')
  printLabel(@ReqUser() u: ReqUserPayload, @Body() body: { fulfillmentOrderId: string }) {
    if (!body?.fulfillmentOrderId) throw new BadRequestException('fulfillmentOrderId obrigatório.')
    return this.svc.printLabel(this.org(u), u.id, body.fulfillmentOrderId)
  }

  // ── Empresas & Contas (Onda A — multi-CNPJ / multiconta) ─────────────
  @Get('companies')
  listCompanies(@ReqUser() u: ReqUserPayload) {
    return this.accounts.listCompanies(this.org(u))
  }

  @Post('companies')
  createCompany(@ReqUser() u: ReqUserPayload, @Body() body: { name: string; cnpj?: string | null; role?: CompanyRole }) {
    if (!body?.name?.trim()) throw new BadRequestException('Informe o nome da empresa.')
    return this.accounts.createCompany(this.org(u), body)
  }

  @Patch('companies/:id')
  updateCompany(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { name?: string; cnpj?: string | null; role?: CompanyRole; is_active?: boolean }) {
    return this.accounts.updateCompany(this.org(u), id, body ?? {})
  }

  @Get('accounts')
  listAccounts(@ReqUser() u: ReqUserPayload) {
    return this.accounts.listAccounts(this.org(u))
  }

  @Patch('accounts/:id')
  updateAccount(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { company_id?: string | null; label?: string; is_active?: boolean; invoice_sale_pct?: number | null; invoice_purchase_pct?: number | null }) {
    return this.accounts.updateAccount(this.org(u), id, body ?? {})
  }

  // ── Wave IA (separação em ondas — W1) ─────────────────────────────────
  @Get('waves')
  listWaves(@ReqUser() u: ReqUserPayload, @Query('warehouse_id') warehouseId?: string) {
    return this.waves.listWaves(this.org(u), warehouseId)
  }

  @Get('waves/:id')
  getWave(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.waves.getWave(this.org(u), id)
  }

  @Post('waves')
  createWave(@ReqUser() u: ReqUserPayload, @Body() body: { warehouseId?: string; name?: string; fulfillmentOrderIds?: string[] }) {
    if (!Array.isArray(body?.fulfillmentOrderIds) || body.fulfillmentOrderIds.length === 0) {
      throw new BadRequestException('Selecione ao menos 1 pedido pra montar a onda.')
    }
    return this.waves.createWave(this.org(u), u.id, { warehouseId: body.warehouseId, name: body.name, fulfillmentOrderIds: body.fulfillmentOrderIds })
  }

  @Post('waves/suggest')
  suggestWave(@ReqUser() u: ReqUserPayload, @Body() body: { warehouseId?: string; selectedIds?: string[] }) {
    return this.waves.suggestForWave(this.org(u), body?.warehouseId, body?.selectedIds ?? [])
  }

  @Post('waves/:id/release')
  releaseWave(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.waves.releaseWave(this.org(u), u.id, id)
  }

  @Post('waves/:id/scan-item')
  scanWaveItem(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { code: string }) {
    if (!body?.code) throw new BadRequestException('Código bipado vazio.')
    return this.waves.scanWaveItem(this.org(u), u.id, id, body.code)
  }

  @Post('waves/:id/orders/:foId/complete')
  completeWaveOrder(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Param('foId') foId: string) {
    return this.waves.completeOrderInWave(this.org(u), u.id, id, foId)
  }

  @Post('waves/:id/cancel')
  cancelWave(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.waves.cancelWave(this.org(u), id)
  }
}
