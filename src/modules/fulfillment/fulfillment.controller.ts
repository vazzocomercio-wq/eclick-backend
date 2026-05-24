import {
  Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { FulfillmentService } from './fulfillment.service'
import type { SeedItem, SourceType, FulfillmentSettings, DamageSeverity, DamageResolution, OperatorRole } from './fulfillment.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * F12 Fulfillment — endpoints do operador + setup.
 * Todos exigem login (SupabaseAuthGuard) e são escopados por org.
 */
@Controller('fulfillment')
@UseGuards(SupabaseAuthGuard)
export class FulfillmentController {
  constructor(private readonly svc: FulfillmentService) {}

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
}
