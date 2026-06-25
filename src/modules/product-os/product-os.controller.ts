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
import { PrinterService, type Printer } from './printer.service'
import { ProductOsActiveService } from './product-os-active.service'
import { MakerworldRadarService } from './makerworld-radar.service'
import { ModelSourceRegistry } from './model-sources/model-source.registry'
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
    private readonly printers: PrinterService,
    private readonly active: ProductOsActiveService,
    private readonly radar: MakerworldRadarService,
    private readonly sources: ModelSourceRegistry,
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
  previewOrder(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; version_id?: string; quantity: number }) {
    return this.production.previewOrderConsumption(this.org(u), body)
  }

  @Post('production-orders')
  @RequirePermission('products.update')
  createOrder(@ReqUser() u: ReqUserPayload, @Body() body: { product_dev_id: string; version_id?: string; quantity: number; machine?: string; printer_id?: string; is_prototype?: boolean }) {
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

  @Patch('production-inputs/:iid')
  @RequirePermission('products.update')
  updateInput(@ReqUser() u: ReqUserPayload, @Param('iid') iid: string, @Body() body: Partial<ProductionInput>) {
    return this.inputs.update(this.org(u), iid, body)
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
  publish(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { produced_quantity?: number; target_margin_pct?: number } = {}) {
    return this.svc.publishToCatalog(id, this.org(u), u.id, body)
  }
}
