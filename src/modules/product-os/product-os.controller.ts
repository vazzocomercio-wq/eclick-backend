import {
  Controller, Get, Post, Patch, Put, Body, Param, Query,
  UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import {
  ProductOsService,
  type ProductDev, type ProductDevStatus, type ProductionProfile, type ReferenceImage, type ProductDevVersion,
} from './product-os.service'
import { ProductionService } from './production.service'
import { ProductionInputService, type ProductionInput } from './production-input.service'
import { ProductPartService } from './product-part.service'
import { PrinterService, type Printer } from './printer.service'
import { ProductOsActiveService } from './product-os-active.service'
import { MakeToOrderService, type MtoConfig } from './make-to-order.service'
import { SkuService } from './sku.service'
import { PaletteService, type PaletteColor } from './palette.service'
import { MakerworldRadarService } from './makerworld-radar.service'
import { ModelSourceRegistry } from './model-sources/model-source.registry'
import { NfeImportService } from './nfe-import.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('product-os')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ProductOsController {
  constructor(
    private readonly svc: ProductOsService,
    private readonly production: ProductionService,
    private readonly inputs: ProductionInputService,
    private readonly parts: ProductPartService,
    private readonly printers: PrinterService,
    private readonly active: ProductOsActiveService,
    private readonly mto: MakeToOrderService,
    private readonly sku: SkuService,
    private readonly palettes: PaletteService,
    private readonly radar: MakerworldRadarService,
    private readonly sources: ModelSourceRegistry,
    private readonly nfe: NfeImportService,
  ) {}

  private org(u: ReqUserPayload): string {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return u.orgId
  }

  // ══ rotas estáticas primeiro (antes de :id) ═══════════════════════
  @Get('settings')
  @RequirePermission('products.view')
  getSettings(@ReqUser() u: ReqUserPayload) { return this.svc.getSettings(this.org(u)) }

  @Put('settings')
  @RequirePermission('products.update')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: {
    filament_cost_per_kg?: Record<string, number>; energy_cost_per_hour?: number
    labor_cost_per_hour?: number; packaging_cost?: number; default_waste_pct?: number
    machines?: Array<{ name: string; model?: string; bed_mm?: number[] }>
  }) { return this.svc.updateSettings(this.org(u), body) }

  // ── Gerador de SKU: catálogo de taxonomia ─────────────────────────
  @Get('sku/taxonomy')
  @RequirePermission('products.view')
  skuTaxonomy(@ReqUser() u: ReqUserPayload, @Query('kind') kind: string, @Query('parent_id') parentId?: string) {
    return this.sku.listTaxonomy(this.org(u), kind, parentId || null)
  }

  @Post('sku/taxonomy')
  @RequirePermission('products.update')
  skuTaxonomyCreate(@ReqUser() u: ReqUserPayload, @Body() body: { kind: string; label: string; parent_id?: string | null; code?: string; notes?: string }) {
    return this.sku.createTaxonomy(this.org(u), u.id, body)
  }

  @Patch('sku/taxonomy/:tid')
  @RequirePermission('products.update')
  skuTaxonomyUpdate(@ReqUser() u: ReqUserPayload, @Param('tid') tid: string, @Body() body: { label?: string; notes?: string; sort_order?: number }) {
    return this.sku.updateTaxonomy(this.org(u), tid, body)
  }

  @Post('sku/taxonomy/:tid/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  skuTaxonomyDelete(@ReqUser() u: ReqUserPayload, @Param('tid') tid: string) {
    return this.sku.deleteTaxonomy(this.org(u), tid)
  }

  // ── Paletas de cor por categoria (recurso próprio do Product OS) ──
  @Get('palettes')
  @RequirePermission('products.view')
  listPalettes(@ReqUser() u: ReqUserPayload, @Query('category_id') categoryId?: string) {
    return this.palettes.list(this.org(u), categoryId || null)
  }

  @Post('palettes')
  @RequirePermission('products.update')
  createPalette(@ReqUser() u: ReqUserPayload, @Body() body: { name: string; category_id?: string | null; colors?: PaletteColor[]; notes?: string; is_primary?: boolean }) {
    return this.palettes.create(this.org(u), u.id, body)
  }

  @Patch('palettes/:pid')
  @RequirePermission('products.update')
  updatePalette(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { name?: string; category_id?: string | null; colors?: PaletteColor[]; notes?: string | null }) {
    return this.palettes.update(this.org(u), pid, body)
  }

  @Post('palettes/:pid/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  deletePalette(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) {
    return this.palettes.remove(this.org(u), pid)
  }

  @Post('palettes/:pid/primary')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  setPrimaryPalette(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) {
    return this.palettes.setPrimary(this.org(u), pid)
  }

  // ── Make-to-order (T1-B): reposição da produção a partir do estoque ──
  @Get('make-to-order/suggestions')
  @RequirePermission('products.view')
  mtoSuggestions(@ReqUser() u: ReqUserPayload, @Query('status') status?: string) {
    return this.mto.listSuggestions(this.org(u), status || 'pending')
  }

  @Post('make-to-order/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  mtoReconcile(@ReqUser() u: ReqUserPayload) {
    return this.mto.reconcile(this.org(u), 'manual')
  }

  @Post('make-to-order/suggestions/:sid/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  mtoAccept(@ReqUser() u: ReqUserPayload, @Param('sid') sid: string, @Body() body: { quantity?: number; printer_id?: string }) {
    return this.mto.acceptSuggestion(this.org(u), sid, u.id, body)
  }

  @Post('make-to-order/suggestions/:sid/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  mtoDismiss(@ReqUser() u: ReqUserPayload, @Param('sid') sid: string) {
    return this.mto.dismissSuggestion(this.org(u), sid, u.id)
  }

  @Post('versions/:vid/approval')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  setVersionApproval(@ReqUser() u: ReqUserPayload, @Param('vid') vid: string, @Body() body: { approved: boolean }) {
    return this.svc.setVersionApproval(vid, this.org(u), body?.approved === true)
  }

  @Patch('versions/:vid')
  @RequirePermission('products.update')
  updateVersion(@ReqUser() u: ReqUserPayload, @Param('vid') vid: string, @Body() body: Partial<ProductDevVersion>) {
    return this.svc.updateVersion(vid, this.org(u), body)
  }

  @Post('versions/:vid/remove-file')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  removeVersionFile(@ReqUser() u: ReqUserPayload, @Param('vid') vid: string) {
    return this.svc.removeVersionFile(vid, this.org(u))
  }

  // ── ordens de produção ────────────────────────────────────────────
  @Get('production-orders')
  @RequirePermission('products.view')
  listOrders(@ReqUser() u: ReqUserPayload, @Query('status') status?: string) {
    return this.production.listOrders(this.org(u), { status })
  }

  @Post('production-orders/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  previewOrder(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; version_id?: string; quantity: number; part_id?: string | null }) {
    return this.production.previewOrderConsumption(this.org(u), body)
  }

  @Post('production-orders')
  @RequirePermission('products.update')
  createOrder(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; version_id?: string; quantity: number; machine?: string; printer_id?: string; is_prototype?: boolean; part_id?: string | null; loaded_input_id?: string | null; filament_map?: Array<{ index: number; input_id: string }> | null }) {
    return this.production.createOrder(this.org(u), u.id, body)
  }

  @Get('production-orders/:oid')
  @RequirePermission('products.view')
  getOrder(@ReqUser() u: ReqUserPayload, @Param('oid') oid: string) { return this.production.getOrder(this.org(u), oid) }

  @Post('production-orders/:oid/transition')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  transitionOrder(@ReqUser() u: ReqUserPayload, @Param('oid') oid: string, @Body() body: { status: string }) {
    return this.production.transitionOrder(this.org(u), oid, body.status, u.id)
  }

  @Patch('production-orders/:oid')
  @RequirePermission('products.update')
  updateOrder(@ReqUser() u: ReqUserPayload, @Param('oid') oid: string, @Body() body: { actual_filament_g?: number | null; actual_time_minutes?: number | null; notes?: string | null; due_at?: string | null }) {
    return this.production.updateOrder(this.org(u), oid, body)
  }

  @Get('production-orders/:oid/units')
  @RequirePermission('products.view')
  listUnits(@ReqUser() u: ReqUserPayload, @Param('oid') oid: string) { return this.production.listUnits(this.org(u), oid) }

  @Get('production-orders/:oid/jobs')
  @RequirePermission('products.view')
  listJobs(@ReqUser() u: ReqUserPayload, @Param('oid') oid: string) { return this.production.listJobs(this.org(u), oid) }

  @Post('production-orders/:oid/jobs')
  @RequirePermission('products.update')
  createJobs(@ReqUser() u: ReqUserPayload, @Param('oid') oid: string, @Body() body: { machine?: string; count?: number }) {
    return this.production.createJobs(this.org(u), u.id, oid, body)
  }

  @Post('jobs/:jid/transition')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  transitionJob(@ReqUser() u: ReqUserPayload, @Param('jid') jid: string, @Body() body: { status: string; filament_used_g?: number; print_time_minutes?: number; failure_reason?: string }) {
    return this.production.transitionJob(this.org(u), jid, body)
  }

  // ── peças (partes do produto) ─────────────────────────────────────
  @Get('parts')
  @RequirePermission('products.view')
  listParts(@ReqUser() u: ReqUserPayload, @Query('product_dev_id') devId: string) {
    if (!devId) throw new BadRequestException('product_dev_id é obrigatório')
    return this.parts.listParts(this.org(u), devId)
  }

  @Post('parts')
  @RequirePermission('products.update')
  createPart(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; name: string; qty_per_product?: number; is_optional?: boolean; sort_order?: number; notes?: string; width_mm?: number | null; depth_mm?: number | null; height_mm?: number | null }) {
    if (!body?.product_dev_id) throw new BadRequestException('product_dev_id é obrigatório')
    return this.parts.createPart(this.org(u), body.product_dev_id, u.id, body)
  }

  @Post('parts/bulk')
  @RequirePermission('products.update')
  createPartsBulk(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; parts: Array<{ name: string; qty_per_product?: number; is_optional?: boolean; width_mm?: number | null; depth_mm?: number | null; height_mm?: number | null }> }) {
    if (!body?.product_dev_id) throw new BadRequestException('product_dev_id é obrigatório')
    return this.parts.createPartsBulk(this.org(u), body.product_dev_id, u.id, body.parts ?? [])
  }

  @Post('suggest-parts')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view', 'ai.view_usage')
  suggestParts(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string }) {
    if (!body?.product_dev_id) throw new BadRequestException('product_dev_id é obrigatório')
    return this.parts.suggestParts(this.org(u), body.product_dev_id)
  }

  @Post('plate-plan')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  platePlan(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; quantity: number }) {
    if (!body?.product_dev_id) throw new BadRequestException('product_dev_id é obrigatório')
    return this.parts.platePlan(this.org(u), body.product_dev_id, body.quantity)
  }

  @Post('cost-from-parts')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  costFromParts(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; target_margin_pct?: number }) {
    if (!body?.product_dev_id) throw new BadRequestException('product_dev_id é obrigatório')
    return this.parts.costFromParts(this.org(u), body.product_dev_id, body)
  }

  @Patch('parts/:pid')
  @RequirePermission('products.update')
  updatePart(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { name?: string; qty_per_product?: number; is_optional?: boolean; sort_order?: number; notes?: string; width_mm?: number | null; depth_mm?: number | null; height_mm?: number | null; code?: string | null }) {
    return this.parts.updatePart(this.org(u), pid, body)
  }

  @Post('parts/:pid/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  deletePart(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) { return this.parts.deletePart(this.org(u), pid) }

  @Post('parts/:pid/adjust-stock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  adjustPartStock(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { quantity: number }) {
    return this.parts.adjustStock(this.org(u), pid, Number(body?.quantity), u.id)
  }

  @Post('parts/:pid/stock-out')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  partStockOut(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { quantity: number; reason?: string }) {
    return this.parts.partStockOut(this.org(u), pid, Number(body?.quantity), body?.reason ?? '', u.id)
  }

  @Get('parts/:pid/versions')
  @RequirePermission('products.view')
  listPartVersions(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) { return this.parts.listPartVersions(this.org(u), pid) }

  @Post('parts/:pid/versions')
  @RequirePermission('products.update')
  async addPartVersion(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: {
    changelog?: string; file_url?: string; file_type?: string; material?: string
    weight_g?: number; print_time_minutes?: number; volume_cm3?: number; prototype_photo_urls?: string[]; notes?: string
    filaments?: Array<{ index: number; material: string | null; color: string | null; weight_g: number }> | null
  }) {
    // blindagem: se veio .3mf mas sem peso/cores (corrida no upload), lê do arquivo no servidor
    if (body.file_url && /\.3mf($|\?)/i.test(body.file_url) && (body.weight_g == null || !body.filaments?.length)) {
      try {
        const m = await this.svc.parse3mf(body.file_url)
        if (m.found) body = {
          ...body,
          weight_g: body.weight_g ?? m.weight_g ?? undefined,
          material: body.material ?? m.material ?? undefined,
          print_time_minutes: body.print_time_minutes ?? m.print_time_minutes ?? undefined,
          filaments: (body.filaments?.length ? body.filaments : (m.filaments.length ? m.filaments : undefined)),
        }
      } catch { /* best-effort */ }
    }
    return this.parts.addPartVersion(this.org(u), pid, u.id, body)
  }

  @Get('parts/:pid/movements')
  @RequirePermission('products.view')
  partMovements(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) { return this.parts.listPartMovements(this.org(u), pid) }

  // ── montagem (assembly) ───────────────────────────────────────────
  @Post('assemblies/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  previewAssembly(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; quantity: number }) {
    if (!body?.product_dev_id) throw new BadRequestException('product_dev_id é obrigatório')
    return this.parts.previewAssembly(this.org(u), body.product_dev_id, body.quantity)
  }

  @Get('assemblies')
  @RequirePermission('products.view')
  listAssemblies(@ReqUser() u: ReqUserPayload, @Query('product_dev_id') devId?: string, @Query('status') status?: string) {
    return this.parts.listAssemblies(this.org(u), { product_dev_id: devId, status })
  }

  @Post('assemblies')
  @RequirePermission('products.update')
  createAssembly(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; quantity: number }) {
    if (!body?.product_dev_id) throw new BadRequestException('product_dev_id é obrigatório')
    return this.parts.createAssembly(this.org(u), body.product_dev_id, u.id, body.quantity)
  }

  @Get('assemblies/:aid')
  @RequirePermission('products.view')
  getAssembly(@ReqUser() u: ReqUserPayload, @Param('aid') aid: string) { return this.parts.getAssembly(this.org(u), aid) }

  @Post('assemblies/:aid/transition')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  transitionAssembly(@ReqUser() u: ReqUserPayload, @Param('aid') aid: string, @Body() body: { status: string }) {
    return this.parts.transitionAssembly(this.org(u), aid, body.status, u.id)
  }

  // ── insumos ───────────────────────────────────────────────────────
  @Get('production-inputs')
  @RequirePermission('products.view')
  listInputs(@ReqUser() u: ReqUserPayload, @Query('kind') kind?: string, @Query('low_stock') low?: string) {
    return this.inputs.list(this.org(u), { kind, lowStock: low === '1' || low === 'true' })
  }

  @Post('production-inputs')
  @RequirePermission('products.update')
  createInput(@ReqUser() u: ReqUserPayload, @Body() body: Partial<ProductionInput> & { name: string }) {
    return this.inputs.create(this.org(u), body)
  }

  // ── Importar NF de insumo (XML → fornecedor + insumos) ────────────
  @Post('production-inputs/import-nfe/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  importNfePreview(@ReqUser() u: ReqUserPayload, @Body() body: { xml: string }) {
    if (!body?.xml?.trim()) throw new BadRequestException('Envie o XML da NF.')
    return this.nfe.importPreview(this.org(u), body.xml)
  }

  @Post('production-inputs/import-nfe/preview-pdf')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view', 'ai.view_usage')
  importNfePreviewPdf(@ReqUser() u: ReqUserPayload, @Body() body: { pdf_base64: string }) {
    if (!body?.pdf_base64?.trim()) throw new BadRequestException('Envie o PDF da NF.')
    return this.nfe.importPreviewFromPdf(this.org(u), body.pdf_base64)
  }

  @Post('production-inputs/import-nfe')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  importNfe(@ReqUser() u: ReqUserPayload, @Body() body: Parameters<NfeImportService['importCommit']>[2]) {
    return this.nfe.importCommit(this.org(u), u.id, body)
  }

  @Patch('production-inputs/:iid')
  @RequirePermission('products.update')
  updateInput(@ReqUser() u: ReqUserPayload, @Param('iid') iid: string, @Body() body: Partial<ProductionInput>) {
    return this.inputs.update(this.org(u), iid, body)
  }

  @Post('production-inputs/:iid/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  deleteInput(@ReqUser() u: ReqUserPayload, @Param('iid') iid: string) {
    return this.inputs.deleteInput(this.org(u), iid)
  }

  @Post('production-inputs/:iid/movement')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  inputMovement(@ReqUser() u: ReqUserPayload, @Param('iid') iid: string, @Body() body: { type: 'in' | 'adjust'; quantity: number; unit_cost?: number; notes?: string }) {
    return this.inputs.movement(this.org(u), iid, body, u.id)
  }

  @Get('production-inputs/:iid/movements')
  @RequirePermission('products.view')
  inputMovements(@ReqUser() u: ReqUserPayload, @Param('iid') iid: string) { return this.inputs.listMovements(this.org(u), iid) }

  // ── impressoras + rentabilidade ───────────────────────────────────
  @Get('printers')
  @RequirePermission('products.view')
  listPrinters(@ReqUser() u: ReqUserPayload) { return this.printers.list(this.org(u)) }

  @Post('printers')
  @RequirePermission('products.update')
  createPrinter(@ReqUser() u: ReqUserPayload, @Body() body: Partial<Printer> & { name: string }) { return this.printers.create(this.org(u), body) }

  @Get('printers/:pid')
  @RequirePermission('products.view')
  getPrinter(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) { return this.printers.get(this.org(u), pid) }

  @Get('printers/:pid/analytics')
  @RequirePermission('products.view')
  printerAnalytics(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) { return this.printers.analytics(this.org(u), pid) }

  @Patch('printers/:pid')
  @RequirePermission('products.update')
  updatePrinter(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: Partial<Printer>) { return this.printers.update(this.org(u), pid, body) }

  // ── filamento carregado na impressora (rastreio por rolo) ─────────
  @Get('printers/:pid/loaded-filament')
  @RequirePermission('products.view')
  getLoaded(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) { return this.inputs.getLoaded(this.org(u), pid) }

  @Get('printers/:pid/filament-history')
  @RequirePermission('products.view')
  filamentHistory(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string) { return this.inputs.loadHistory(this.org(u), pid) }

  @Post('printers/:pid/load-filament')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  loadFilament(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { input_id: string; slot?: number; loaded_g?: number | null }) {
    if (!body?.input_id) throw new BadRequestException('Escolha o filamento (insumo).')
    return this.inputs.loadFilament(this.org(u), pid, body.input_id, body.slot ?? 0, body.loaded_g ?? null, u.id)
  }

  @Post('printers/:pid/unload-filament')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  unloadFilament(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { slot?: number }) {
    return this.inputs.unloadFilament(this.org(u), pid, body?.slot ?? 0, u.id)
  }

  @Post('printers/:pid/filament-usage')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  filamentUsage(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { grams: number; notes?: string; slot?: number }) {
    return this.inputs.logManualUsage(this.org(u), pid, Number(body?.grams), body?.notes ?? null, u.id, body?.slot ?? null)
  }

  @Get('profitability')
  @RequirePermission('products.view')
  profitability(@ReqUser() u: ReqUserPayload) { return this.production.profitability(this.org(u)) }

  @Get('factory-overview')
  @RequirePermission('products.view')
  factoryOverview(@ReqUser() u: ReqUserPayload) { return this.production.factoryOverview(this.org(u)) }

  @Post('parse-slicer')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  parseSlicer(@ReqUser() u: ReqUserPayload, @Body() body: { text: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.parseSlicer(body?.text ?? '')
  }

  @Post('parse-3mf')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  parse3mf(@ReqUser() u: ReqUserPayload, @Body() body: { url: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.parse3mf(body?.url ?? '')
  }

  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  uploadUrl(@ReqUser() u: ReqUserPayload, @Body() body: { filename: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createUploadUrl(u.orgId, body?.filename ?? 'arquivo')
  }

  @Post('delete-file')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  deleteFile(@ReqUser() u: ReqUserPayload, @Body() body: { url: string }) {
    return this.svc.deleteFile(this.org(u), body?.url ?? '')
  }

  @Get('production-plan')
  @RequirePermission('products.view')
  productionPlan(@ReqUser() u: ReqUserPayload, @Query('hours') hours?: string) {
    return this.production.productionPlan(this.org(u), hours ? Number(hours) : undefined)
  }

  // ── Fontes de modelos 3D (multi-plataforma) ───────────────────────
  @Get('sources')
  @RequirePermission('products.view')
  listSources() {
    return this.sources.all().map(p => ({ platform: p.platform, label: p.label, configured: p.isConfigured(), can_creator: !!p.listByCreator, can_discover: !!p.discover, can_categories: !!p.listCategories, can_search: !!p.search }))
  }

  // ── Watchlist de criadores (Fase E) ───────────────────────────────
  @Get('creators')
  @RequirePermission('products.view')
  listCreators(@ReqUser() u: ReqUserPayload) { return this.radar.listCreators(this.org(u)) }

  @Post('creators')
  @RequirePermission('products.update')
  addCreator(@ReqUser() u: ReqUserPayload, @Body() body: { platform: string; handle: string }) {
    if (!body?.platform || !body?.handle?.trim()) throw new BadRequestException('Informe a plataforma e o nick do criador.')
    return this.radar.addCreator(this.org(u), u.id, body.platform, body.handle)
  }

  @Get('creators/:cid/models')
  @RequirePermission('products.view')
  creatorModels(@ReqUser() u: ReqUserPayload, @Param('cid') cid: string) { return this.radar.creatorModels(this.org(u), cid) }

  @Post('creators/:cid/remove')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  removeCreator(@ReqUser() u: ReqUserPayload, @Param('cid') cid: string) { return this.radar.removeCreator(this.org(u), cid) }

  @Post('creators/scan-novelties')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  scanNovelties(@ReqUser() u: ReqUserPayload) { return this.radar.scanCreatorNovelties(this.org(u)) }

  // ── Feed "em alta" / descoberta (Fase D) ──────────────────────────
  @Get('discover')
  @RequirePermission('products.view')
  discover(@ReqUser() u: ReqUserPayload, @Query('platform') platform: string, @Query('commercial') commercial?: string, @Query('category') category?: string, @Query('q') q?: string, @Query('sort') sort?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!platform) throw new BadRequestException('Informe a plataforma.')
    const onlyCommercial = commercial === '1' || commercial === 'true'
    // palavra-chave tem prioridade sobre categoria
    if (q?.trim()) return this.radar.search(platform, q.trim(), { commercialOnly: onlyCommercial })
    return this.radar.discover(platform, { commercialOnly: onlyCommercial, categorySlug: category || undefined, sort: sort === 'recent' ? 'recent' : 'downloads' })
  }

  @Get('categories')
  @RequirePermission('products.view')
  listCategories(@ReqUser() u: ReqUserPayload, @Query('platform') platform: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!platform) throw new BadRequestException('Informe a plataforma.')
    return this.radar.listCategories(platform)
  }

  // ── Radar de campeões (Peça 3) ────────────────────────────────────
  @Get('radar')
  @RequirePermission('products.view')
  radarList(@ReqUser() u: ReqUserPayload) { return this.radar.list(this.org(u)) }

  @Post('radar')
  @RequirePermission('products.update')
  radarAdd(@ReqUser() u: ReqUserPayload, @Body() body: { url: string }) {
    if (!body?.url?.trim()) throw new BadRequestException('Informe o link ou o ID do modelo MakerWorld.')
    return this.radar.addToWatch(this.org(u), u.id, body.url)
  }

  @Post('radar/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  radarRefreshAll(@ReqUser() u: ReqUserPayload) { return this.radar.refresh(this.org(u)) }

  @Post('radar/:rid/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  radarRefresh(@ReqUser() u: ReqUserPayload, @Param('rid') rid: string) { return this.radar.refresh(this.org(u), rid) }

  @Post('radar/:rid/decision')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  radarDecision(@ReqUser() u: ReqUserPayload, @Param('rid') rid: string, @Body() body: { decision: 'observar' | 'comprar' | 'ignorar'; notes?: string }) {
    return this.radar.setDecision(this.org(u), rid, body.decision, body.notes)
  }

  @Post('radar/:rid/ai-suggest')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update', 'ai.view_usage')
  radarAiSuggest(@ReqUser() u: ReqUserPayload, @Param('rid') rid: string) { return this.radar.aiSuggest(this.org(u), rid) }

  @Post('radar/:rid/remove')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  radarRemove(@ReqUser() u: ReqUserPayload, @Param('rid') rid: string) { return this.radar.remove(this.org(u), rid) }

  // ── Importar do MakerWorld (Peça 1) ───────────────────────────────
  @Post('import/makerworld/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  importMakerworldPreview(@ReqUser() u: ReqUserPayload, @Body() body: { url: string }) {
    if (!body?.url?.trim()) throw new BadRequestException('Informe o link ou o ID do modelo MakerWorld.')
    return this.svc.importPreview(this.org(u), body.url)
  }

  @Post('import/makerworld')
  @RequirePermission('products.update')
  importMakerworld(@ReqUser() u: ReqUserPayload, @Body() body: { url: string; create_version?: boolean }) {
    if (!body?.url?.trim()) throw new BadRequestException('Informe o link ou o ID do modelo MakerWorld.')
    return this.svc.importFromMakerworld(this.org(u), u.id, body.url, { create_version: body.create_version })
  }

  // ══ coleção ═══════════════════════════════════════════════════════
  @Get()
  @RequirePermission('products.view')
  list(@ReqUser() u: ReqUserPayload, @Query('status') status?: ProductDevStatus) {
    return this.svc.list(this.org(u), { status })
  }

  @Post()
  @RequirePermission('products.update')
  create(@ReqUser() u: ReqUserPayload, @Body() body: {
    name: string; category?: string; description?: string; production_profile?: ProductionProfile
    inspiration_url?: string; reference_images?: ReferenceImage[]; target_marketplaces?: string[]; target_price?: number
  }) { return this.svc.create(this.org(u), u.id, body) }

  // ══ item (:id) ════════════════════════════════════════════════════
  @Get(':id')
  @RequirePermission('products.view')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) { return this.svc.get(id, this.org(u)) }

  @Patch(':id')
  @RequirePermission('products.update')
  update(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<ProductDev>) {
    return this.svc.update(id, this.org(u), body)
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  move(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { status?: ProductDevStatus; position?: number }) {
    return this.svc.move(id, this.org(u), body)
  }

  @Patch(':id/make-to-order')
  @RequirePermission('products.update')
  setMtoConfig(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<MtoConfig>) {
    return this.mto.setConfig(this.org(u), id, body)
  }

  @Get(':id/sku')
  @RequirePermission('products.view')
  getSku(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.sku.getSku(this.org(u), id)
  }

  @Put(':id/sku')
  @RequirePermission('products.update')
  setSkuClassification(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { marca_id: string; categoria_id: string; sub_id: string; linha_id: string; caracteristica_id: string }) {
    return this.sku.setClassification(this.org(u), id, body)
  }

  @Put(':id/sku/colors')
  @RequirePermission('products.update')
  setSkuColors(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { cor_ids: string[] }) {
    return this.sku.setColors(this.org(u), id, body?.cor_ids ?? [])
  }

  @Post(':id/sku/generate-ean')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  generateEan(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { force?: boolean }) {
    return this.sku.generateEans(this.org(u), id, body?.force === true)
  }

  @Put('sku/variant/:vid/ean')
  @RequirePermission('products.update')
  setVariantEan(@ReqUser() u: ReqUserPayload, @Param('vid') vid: string, @Body() body: { ean: string | null }) {
    return this.sku.setVariantEan(this.org(u), vid, body?.ean ?? null)
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  archive(@ReqUser() u: ReqUserPayload, @Param('id') id: string) { return this.svc.archive(id, this.org(u)) }

  @Post(':id/briefing')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update', 'ai.view_usage')
  briefing(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: {
    dimensions?: { width_mm?: number; depth_mm?: number; height_mm?: number }; material?: string; wall_thickness_mm?: number; notes?: string
  } = {}) { return this.svc.generateBriefing(id, this.org(u), body) }

  @Post(':id/cost')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  cost(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: {
    version_id?: string; weight_g?: number; print_time_minutes?: number; material?: string; target_margin_pct?: number
  } = {}) { return this.svc.computeCost(id, this.org(u), body) }

  @Get(':id/versions')
  @RequirePermission('products.view')
  listVersions(@ReqUser() u: ReqUserPayload, @Param('id') id: string) { return this.svc.listVersions(id, this.org(u)) }

  @Post(':id/versions')
  @RequirePermission('products.update')
  addVersion(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: {
    changelog?: string; file_url?: string; file_type?: string; material?: string
    weight_g?: number; print_time_minutes?: number; volume_cm3?: number; prototype_photo_urls?: string[]; notes?: string
  }) { return this.svc.addVersion(id, this.org(u), u.id, body) }

  // ── BOM ───────────────────────────────────────────────────────────
  @Get(':id/bom')
  @RequirePermission('products.view')
  getBom(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Query('version_id') vid?: string) {
    return this.production.getBom(this.org(u), id, vid)
  }

  @Put(':id/bom')
  @RequirePermission('products.update')
  putBom(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { version_id?: string; lines: Array<{ kind: string; description?: string; input_id?: string; quantity: number; unit?: string; unit_cost?: number; waste_pct?: number; sort_order?: number }> }) {
    return this.production.replaceBom(this.org(u), id, u.id, body)
  }

  @Post(':id/cost-bom')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  costBom(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { version_id?: string; target_margin_pct?: number } = {}) {
    return this.production.costFromBom(this.org(u), id, body)
  }

  @Get(':id/cost-reality')
  @RequirePermission('products.view')
  costReality(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.production.costReality(this.org(u), id)
  }

  // ── qualidade ─────────────────────────────────────────────────────
  @Get(':id/quality')
  @RequirePermission('products.view')
  getQuality(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Query('version_id') vid?: string) {
    return this.production.getQuality(this.org(u), id, vid)
  }

  @Put(':id/quality')
  @RequirePermission('products.update')
  putQuality(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { version_id?: string; production_order_id?: string; checklist: Array<{ key: string; label: string; ok: boolean }>; approved: boolean; notes?: string }) {
    return this.production.upsertQuality(this.org(u), id, u.id, body)
  }

  // ── timeline ──────────────────────────────────────────────────────
  @Get(':id/events')
  @RequirePermission('products.view')
  events(@ReqUser() u: ReqUserPayload, @Param('id') id: string) { return this.svc.listEvents(id, this.org(u)) }

  // ── Active dispatch + publicação ──────────────────────────────────
  @Post(':id/dispatch')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  dispatch(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { assigned_to?: string; note?: string; stage?: string } = {}) {
    return this.active.dispatch(id, this.org(u), u.id, body)
  }

  @Post(':id/license-clearance')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  licenseClearance(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { cleared: boolean; note?: string }) {
    return this.svc.setLicenseClearance(id, this.org(u), u.id, body)
  }

  @Post(':id/publish-to-catalog')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  publish(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { produced_quantity?: number; target_margin_pct?: number; variation_mode?: 'single' | 'variable'; variants?: Array<{ id: string; price?: number | null; stock?: number | null }> } = {}) {
    return this.svc.publishToCatalog(id, this.org(u), u.id, body)
  }

  @Post(':id/generate-image')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  generateImage(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { palette_id?: string; extra?: string; format?: 'square' | 'story' | 'wide'; save?: boolean; use_reference?: boolean; reference_url?: string; reference_urls?: string[] } = {}) {
    return this.svc.generateImageWithPalette(this.org(u), id, body)
  }
}
