import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { AlertSignalsService } from '../alert-signals.service'
import { AlertEngineService } from '../alert-engine.service'
import { EstoqueAnalyzer } from './estoque.analyzer'
import { ComprasAnalyzer } from './compras.analyzer'
import { MargemAnalyzer } from './margem.analyzer'
import { AdsAnalyzer } from './ads.analyzer'
// PrecoAnalyzer removido em PRC-2 — PricingIntelligence é fonte única.
import { BaseAnalyzer } from './base.analyzer'
import type { AnalyzerName } from './analyzers.types'

/**
 * Disparador automático de analyzers por org.
 *
 * Cada org tem `alert_hub_config.analyzers_config` com toggle por analyzer
 * (`enabled`) e `min_score`. A intervalo configurado por analyzer no spec
 * original, mas no MVP usamos um cron único de 15min — mais simples e
 * suficiente pro padrão de uso atual.
 *
 * Pipeline:
 *   1. Lista orgs com hub.enabled=true
 *   2. Pra cada org, pra cada analyzer registrado:
 *      - Se analyzers_config[name].enabled !== false: executa scan
 *      - Se gerou drafts: insertMany + AlertEngine.processMany
 *   3. Falha em 1 (org, analyzer) não bloqueia outras
 *
 * Trigger manual via POST /analyzers/:name/run continua disponível pra teste.
 */
@Injectable()
export class AnalyzersSchedulerService {
  private readonly logger = new Logger(AnalyzersSchedulerService.name)
  private isRunning = false

  constructor(
    private readonly signalsSvc: AlertSignalsService,
    private readonly engine:     AlertEngineService,
    private readonly estoque:    EstoqueAnalyzer,
    private readonly compras:    ComprasAnalyzer,
    private readonly margem:     MargemAnalyzer,
    private readonly ads:        AdsAnalyzer,
  ) {}

  @Cron('*/15 * * * *', { name: 'alertHubAnalyzersTick' })
  async tick(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      await this.runAll()
    } catch (e) {
      this.logger.error(`[tick] erro inesperado: ${(e as Error).message}`)
    } finally {
      this.isRunning = false
    }
  }

  private async runAll(): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('alert_hub_config')
      .select('organization_id, analyzers_config')
      .eq('enabled', true)
    if (error) {
      this.logger.error(`[runAll] config query: ${error.message}`)
      return
    }

    const configs = (data ?? []) as Array<{
      organization_id:  string
      analyzers_config: Record<string, { enabled?: boolean }>
    }>

    if (configs.length === 0) return

    const analyzers = this.registry()
    let totalSignals    = 0
    let totalDeliveries = 0

    for (const cfg of configs) {
      for (const [name, analyzer] of Object.entries(analyzers)) {
        if (!analyzer) continue   // ainda não implementado
        const isEnabled = cfg.analyzers_config?.[name]?.enabled !== false  // default true
        if (!isEnabled) continue

        try {
          const drafts = await analyzer.scan(cfg.organization_id)
          if (drafts.length === 0) continue
          const signals = await this.signalsSvc.insertMany(cfg.organization_id, drafts)
          const deliveries = await this.engine.processMany(cfg.organization_id, signals)
          totalSignals    += signals.length
          totalDeliveries += deliveries.length
        } catch (e) {
          this.logger.error(`[runAll] org=${cfg.organization_id} analyzer=${name}: ${(e as Error).message}`)
        }
      }
    }

    if (totalSignals > 0) {
      this.logger.log(`[tick] orgs=${configs.length} signals=${totalSignals} deliveries=${totalDeliveries}`)
    }
  }

  /**
   * Registry estático — adicione novos analyzers aqui conforme implementam.
   * cross_intel não fica aqui pois CrossIntelService roda em cron próprio.
   */
  private registry(): Record<AnalyzerName, BaseAnalyzer | undefined> {
    return {
      estoque:     this.estoque,
      compras:     this.compras,
      preco:       undefined,        // PRC-2: PricingIntelligence é fonte
      margem:      this.margem,
      ads:         this.ads,
      cross_intel: undefined,
    } as Record<AnalyzerName, BaseAnalyzer | undefined>
  }
}
