import {
  Controller, Get, Post, Patch, Put, Body, Param, Query,
  UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import {
  ProductOsService,
  type ProductDev, type ProductDevStatus, type ProductionProfile, type ReferenceImage,
} from './product-os.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Product OS — Fase 1.
 *
 * GET    /product-os                       → lista (kanban)
 * GET    /product-os/settings              → constantes de fabricação da org
 * PUT    /product-os/settings              → atualiza constantes
 * POST   /product-os                       → cria produto em desenvolvimento
 * GET    /product-os/:id                   → detalhe (+ versões)
 * PATCH  /product-os/:id                   → edita
 * POST   /product-os/:id/move              → move no kanban (status/posição)
 * POST   /product-os/:id/archive           → arquiva
 * POST   /product-os/:id/briefing          → gera briefing técnico (IA)
 * POST   /product-os/:id/cost              → custo de fabricação + preço sugerido
 * GET    /product-os/:id/versions          → lista versões
 * POST   /product-os/:id/versions          → adiciona versão
 * POST   /product-os/versions/:vid/approval → aprova/reprova versão
 */
@Controller('product-os')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ProductOsController {
  constructor(private readonly svc: ProductOsService) {}

  // ── rotas estáticas primeiro (settings antes de :id) ──────────────
  @Get('settings')
  @RequirePermission('products.view')
  getSettings(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSettings(u.orgId)
  }

  @Put('settings')
  @RequirePermission('products.update')
  updateSettings(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      filament_cost_per_kg?: Record<string, number>
      energy_cost_per_hour?: number
      labor_cost_per_hour?: number
      packaging_cost?: number
      default_waste_pct?: number
      machines?: Array<{ name: string; model?: string; bed_mm?: number[] }>
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateSettings(u.orgId, body)
  }

  @Post('versions/:vid/approval')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  setVersionApproval(
    @ReqUser() u: ReqUserPayload,
    @Param('vid') vid: string,
    @Body() body: { approved: boolean },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.setVersionApproval(vid, u.orgId, body?.approved === true)
  }

  // ── coleção ───────────────────────────────────────────────────────
  @Get()
  @RequirePermission('products.view')
  list(@ReqUser() u: ReqUserPayload, @Query('status') status?: ProductDevStatus) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId, { status })
  }

  @Post()
  @RequirePermission('products.update')
  create(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      name: string
      category?: string
      description?: string
      production_profile?: ProductionProfile
      inspiration_url?: string
      reference_images?: ReferenceImage[]
      target_marketplaces?: string[]
      target_price?: number
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(u.orgId, u.id, body)
  }

  // ── item ──────────────────────────────────────────────────────────
  @Get(':id')
  @RequirePermission('products.view')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(id, u.orgId)
  }

  @Patch(':id')
  @RequirePermission('products.update')
  update(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<ProductDev>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(id, u.orgId, body)
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  move(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { status?: ProductDevStatus; position?: number },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.move(id, u.orgId, body)
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  archive(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.archive(id, u.orgId)
  }

  @Post(':id/briefing')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update', 'ai.view_usage')
  briefing(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      dimensions?: { width_mm?: number; depth_mm?: number; height_mm?: number }
      material?: string
      wall_thickness_mm?: number
      notes?: string
    } = {},
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateBriefing(id, u.orgId, body)
  }

  @Post(':id/cost')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  cost(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      version_id?: string
      weight_g?: number
      print_time_minutes?: number
      material?: string
      target_margin_pct?: number
    } = {},
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.computeCost(id, u.orgId, body)
  }

  @Get(':id/versions')
  @RequirePermission('products.view')
  listVersions(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listVersions(id, u.orgId)
  }

  @Post(':id/versions')
  @RequirePermission('products.update')
  addVersion(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      changelog?: string
      file_url?: string
      file_type?: string
      material?: string
      weight_g?: number
      print_time_minutes?: number
      volume_cm3?: number
      prototype_photo_urls?: string[]
      notes?: string
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.addVersion(id, u.orgId, u.id, body)
  }
}
