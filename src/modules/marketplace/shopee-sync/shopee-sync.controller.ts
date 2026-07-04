import {
  Controller, Get, Post, Body, Query, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ShopeeShopMetricsSyncService } from './shopee-metrics-sync.service'
import { ShopeeCampaignsSyncService } from './shopee-campaigns-sync.service'
import { ShopeeOrdersIngestionService } from './shopee-orders-ingestion.service'
import { ShopeeEscrowIngestService } from './shopee-escrow-ingest.service'
import { ShopeeAdsSpendIngestService } from './shopee-ads-spend-ingest.service'
import { ShopeeStockSyncService } from './shopee-stock-sync.service'
import { ShopeeReturnsSyncService } from './shopee-returns-sync.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F0.7/F1.3 — Triggers manuais dos syncs Shopee.
 *
 *  POST /shopee/sync/products     → anúncios reais → Algorithm Scores (Listing Center).
 *  POST /shopee/sync/shop-metrics → account_health → snapshot do Quality Center
 *                                   (devolve raw_metric_list + errors p/ inspeção).
 *  Idempotente no efeito visível (snapshot por dia / view pega o último). */
@Controller('shopee/sync')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeSyncController {
  constructor(
    private readonly products:  ShopeeProductSyncService,
    private readonly metrics:   ShopeeShopMetricsSyncService,
    private readonly campaigns: ShopeeCampaignsSyncService,
    private readonly orders:    ShopeeOrdersIngestionService,
    private readonly escrow:    ShopeeEscrowIngestService,
    private readonly adsSpend:  ShopeeAdsSpendIngestService,
    private readonly stock:     ShopeeStockSyncService,
    private readonly returns:   ShopeeReturnsSyncService,
  ) {}

  @Post('products')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncProducts(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.products.syncProducts(user.orgId)
  }

  @Post('shop-metrics')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncShopMetrics(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.metrics.syncShopMetrics(user.orgId)
  }

  @Post('campaigns')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncCampaigns(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.campaigns.syncCampaigns(user.orgId)
  }

  /** Gasto REAL de Shopee Ads (diário, 30d) → platform_charges ('ads').
   *  Exige o módulo Ads habilitado no app da Open Platform (senão a resposta
   *  traz errors[] com error_api_permission — nada quebra). */
  @Post('ads-spend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncAdsSpend(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.adsSpend.ingest(user.orgId)
  }

  /** F1.6 — Ingestão de pedidos Shopee na CENTRAL (source='shopee').
   *  body.days controla a janela (default 60; o botão "Sincronizar" da tela
   *  de pedidos manda 3 pra responder dentro do timeout do proxy). */
  @Post('orders')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncOrders(@ReqUser() user: ReqUserPayload, @Body() body?: { days?: number }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const days = Math.min(Math.max(Number(body?.days ?? 0) || 0, 0), 90) || undefined
    return this.orders.syncOrders(user.orgId, days)
  }

  /** Fase 2.3 — Ingere o repasse real (escrow) dos pedidos concluídos →
   *  platform_charges (taxas reais Shopee). Fire-and-forget: 1 call/pedido +
   *  throttle, roda além do timeout do proxy. Acompanhar via /financeiro/charges/summary. */
  @Post('escrow')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncEscrow(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const orgId = user.orgId
    void this.escrow.ingest(orgId, { limit: 600 }).catch(() => { /* logado no service */ })
    return { started: true }
  }

  /** Pós-venda Fase C — Ingestão manual de devoluções (returns API) →
   *  marketplace_returns + enxerto em orders.raw_data->mediations.
   *  body.days estende a janela (default 30, cap 365) pra backfill. */
  @Post('returns')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.view')
  async syncReturns(@ReqUser() user: ReqUserPayload, @Body() body?: { days?: number }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const days = Math.min(Math.max(Number(body?.days ?? 0) || 0, 0), 365) || undefined
    return this.returns.syncReturns(user.orgId, days)
  }

  /** Lista devoluções Shopee pro front (tela Reclamações, canal Shopee). */
  @Get('returns')
  @RequirePermission('orders.view')
  async listReturns(
    @ReqUser() user: ReqUserPayload,
    @Query('status')  status?: string,
    @Query('shop_id') shopId?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.returns.list(user.orgId, { status, shopId })
  }

  /** F18 Fase C — Propaga o disponível do ledger (products.stock) pros anúncios
   *  Shopee vinculados (lote, manual). ⚠️ escreve estoque REAL na loja. */
  @Post('stock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncStock(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.stock.pushStockForOrg(user.orgId)
  }
}
