import {
  Controller, Post, Get, Param, Query, UseGuards,
  BadRequestException, NotFoundException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { AlertSignalsService } from '../alert-signals.service'
import { AlertDeliveriesService } from '../alert-deliveries.service'
import { AlertEngineService } from '../alert-engine.service'
import { WhatsAppDeliveryService } from '../delivery/whatsapp-delivery.service'
import { EstoqueAnalyzer } from './estoque.analyzer'
import { ComprasAnalyzer } from './compras.analyzer'
import { PrecoAnalyzer } from './preco.analyzer'
import { MargemAnalyzer } from './margem.analyzer'
import type { AnalyzerName, AlertSignalStatus, DeliveryStatus } from './analyzers.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Endpoints de orquestração de analyzers + leitura de signals/deliveries.
 *
 *   POST /analyzers/:name/run  → scan + insertMany + AlertEngine.processMany
 *   GET  /alert-signals        → lista signals com filtros
 *   GET  /alert-deliveries     → lista deliveries com filtros
 */
@Controller()
@UseGuards(SupabaseAuthGuard)
export class AnalyzersController {
  constructor(
    private readonly signalsSvc:    AlertSignalsService,
    private readonly deliveriesSvc: AlertDeliveriesService,
    private readonly engine:        AlertEngineService,
    private readonly waDelivery:    WhatsAppDeliveryService,
    private readonly estoque:       EstoqueAnalyzer,
    private readonly compras:       ComprasAnalyzer,
    private readonly preco:         PrecoAnalyzer,
    private readonly margem:        MargemAnalyzer,
  ) {}

  @Post('analyzers/:name/run')
  async run(@ReqUser() u: ReqUserPayload, @Param('name') name: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')

    const analyzer  = this.resolve(name as AnalyzerName)
    const drafts    = await analyzer.scan(u.orgId)
    const signals   = await this.signalsSvc.insertMany(u.orgId, drafts)
    const deliveries = await this.engine.processMany(u.orgId, signals)

    return {
      analyzer: name,
      drafts_count:     drafts.length,
      signals_count:    signals.length,
      deliveries_count: deliveries.length,
      signals,
      deliveries,
    }
  }

  @Get('alert-signals')
  listSignals(
    @ReqUser() u: ReqUserPayload,
    @Query('analyzer')  analyzer?: AnalyzerName,
    @Query('status')    status?:   AlertSignalStatus,
    @Query('min_score') minScore?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.signalsSvc.list(u.orgId, {
      analyzer,
      status,
      min_score: minScore ? Number(minScore) : undefined,
      limit:     limit    ? Number(limit)    : undefined,
    })
  }

  /**
   * Trigger manual do dispatcher WhatsApp (sem esperar o cron de 30s).
   * Processa todos pending+immediate da org da chamada — útil em testes.
   */
  @Post('alert-deliveries/dispatch-now')
  dispatchNow(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.waDelivery.runOnce()
  }

  @Get('alert-deliveries')
  listDeliveries(
    @ReqUser() u: ReqUserPayload,
    @Query('manager_id') managerId?: string,
    @Query('signal_id')  signalId?:  string,
    @Query('status')     status?:    DeliveryStatus,
    @Query('limit')      limit?:     string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.deliveriesSvc.list(u.orgId, {
      manager_id: managerId,
      signal_id:  signalId,
      status,
      limit: limit ? Number(limit) : undefined,
    })
  }

  // ── Registry simples; cresce conforme analyzers chegam ──────────────────────
  private resolve(name: AnalyzerName) {
    switch (name) {
      case 'estoque': return this.estoque
      case 'compras': return this.compras
      case 'preco':   return this.preco
      case 'margem':  return this.margem
      default:
        throw new NotFoundException(`Analyzer '${name}' não disponível ainda`)
    }
  }
}
