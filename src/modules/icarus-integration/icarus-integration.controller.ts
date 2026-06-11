import { Controller, Get, Post, Put, Delete, Param, Query, Body, UseGuards, HttpCode, HttpStatus, BadRequestException, Logger } from '@nestjs/common'
import { IcarusIntegrationService, type ConnectInput } from './icarus-integration.service'
import { IcarusCatalogService } from './icarus-catalog.service'
import { IcarusSyncCron } from './icarus-sync.cron'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Sessão 2026-05-14 — Endpoints da integração Icarus por fornecedor.
 * Rotas vivem sob /suppliers/:supplierId/integrations/icarus pra agrupar
 * com o módulo de fornecedores. Service único pra todos os métodos.
 *
 * Sempre filtra por orgId (multi-tenant), nunca devolve access_token plain.
 */
@Controller('suppliers/:supplierId/integrations/icarus')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class IcarusIntegrationController {
  private readonly log = new Logger(IcarusIntegrationController.name)

  constructor(
    private readonly service: IcarusIntegrationService,
    private readonly catalog: IcarusCatalogService,
    private readonly syncCron: IcarusSyncCron,
  ) {}

  /** POST /suppliers/:supplierId/integrations/icarus
   *  Conecta (ou reconecta) Icarus pro fornecedor. Faz ping antes de persistir. */
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('integrations.connect')
  connect(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
    @Body() body: ConnectInput,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!supplierId) throw new BadRequestException('supplierId obrigatório')
    return this.service.connect(u.orgId, supplierId, u.id, body)
  }

  /** GET /suppliers/:supplierId/integrations/icarus — status atual */
  @Get()
  @RequirePermission('integrations.view')
  get(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.service.getBySupplier(u.orgId, supplierId)
  }

  /** POST /suppliers/:supplierId/integrations/icarus/test — smoke test */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('integrations.view')
  test(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.service.test(u.orgId, supplierId)
  }

  /** DELETE /suppliers/:supplierId/integrations/icarus — desconecta (soft) */
  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('integrations.disconnect')
  disconnect(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.service.disconnect(u.orgId, supplierId)
  }

  // ── Catálogo / sincronização ───────────────────────────────────────────

  /** POST .../catalog/pull — dispara o pull do catálogo em segundo plano.
   *  Responde na hora; a UI acompanha pelo status da integração (polling). */
  @Post('catalog/pull')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.import')
  pullCatalog(@ReqUser() u: ReqUserPayload, @Param('supplierId') supplierId: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    // Catálogo grande pode demorar — roda em segundo plano pra não estourar o
    // tempo da requisição HTTP. Sucesso/erro ficam gravados em supplier_integrations.
    void this.catalog.pullCatalog(u.orgId, supplierId).catch((err: Error) => {
      this.log.error(`[icarus] pull em segundo plano falhou: ${err?.message}`)
    })
    return { started: true }
  }

  /** POST .../stock/reconcile — reconciliação saldo-a-saldo sob demanda
   *  (partner_stock → ledger; o cron de 15min faz o mesmo automaticamente). */
  @Post('stock/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('stock.adjust')
  async reconcileStock(@ReqUser() u: ReqUserPayload, @Param('supplierId') supplierId: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.syncCron.reconcileNow(u.orgId, supplierId)
  }

  /** GET .../catalog — lista do staging com status synced/available/new. */
  @Get('catalog')
  @RequirePermission('products.view')
  listCatalog(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.catalog.listCatalog(u.orgId, supplierId, {
      status,
      search,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  /** GET .../catalog/summary — contagem por status pro cabeçalho. */
  @Get('catalog/summary')
  @RequirePermission('products.view')
  catalogSummary(@ReqUser() u: ReqUserPayload, @Param('supplierId') supplierId: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.catalog.getCatalogSummary(u.orgId, supplierId)
  }

  /** POST .../catalog/sync — sincroniza os itens selecionados. */
  @Post('catalog/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.import')
  syncCatalog(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
    @Body() body: { catalog_item_ids?: string[] },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.catalog.syncSelected(u.orgId, supplierId, body?.catalog_item_ids ?? [])
  }

  /** GET .../discount — desconto geral do fornecedor. */
  @Get('discount')
  @RequirePermission('products.view')
  getDiscount(@ReqUser() u: ReqUserPayload, @Param('supplierId') supplierId: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.catalog.getSupplierDiscount(u.orgId, supplierId)
  }

  /** PUT .../discount — define o desconto geral e recalcula custos. */
  @Put('discount')
  @RequirePermission('products.update')
  setDiscount(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
    @Body() body: { type?: 'percent' | 'fixed' | null; value?: number },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.catalog.setSupplierDiscount(u.orgId, supplierId, body?.type ?? null, Number(body?.value) || 0)
  }

  /** GET .../products — produtos já vinculados (pra ajuste por produto). */
  @Get('products')
  @RequirePermission('products.view')
  listSyncedProducts(
    @ReqUser() u: ReqUserPayload,
    @Param('supplierId') supplierId: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.catalog.listSyncedProducts(u.orgId, supplierId, {
      search,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  /** PUT .../products/:spId/adjustment — ajuste de custo de um produto. */
  @Put('products/:spId/adjustment')
  @RequirePermission('products.update')
  setProductAdjustment(
    @ReqUser() u: ReqUserPayload,
    @Param('spId') spId: string,
    @Body() body: { type?: 'percent' | 'fixed' | 'override' | null; value?: number | null },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const value = body?.value == null ? null : Number(body.value)
    return this.catalog.setProductAdjustment(u.orgId, spId, body?.type ?? null, value)
  }
}

/** Listagem global de todas integrações Icarus da org — usado pelo cron de sync. */
@Controller('integrations/icarus')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class IcarusIntegrationListController {
  constructor(private readonly service: IcarusIntegrationService) {}

  @Get()
  @RequirePermission('integrations.view')
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.service.list(u.orgId)
  }
}
