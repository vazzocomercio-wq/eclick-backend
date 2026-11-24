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
import type { AnalyzerName, SignalDraft } from './analyzers.types'

/** Quanto tempo a mesma situação (analyzer + categoria + produto) fica sem novo aviso.
 *  Margem é lenta (média de 30 dias): 1 aviso por semana basta. Demais: 1 por dia. */
const JANELA_REPETICAO_H: Record<string, number> = { margem: 7 * 24 }

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
          const drafts = await this.soNovos(cfg.organization_id, name, await analyzer.scan(cfg.organization_id))
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
   * Trava de repetição: os analyzers rodam a cada 15 min e devolvem TODA situação vigente,
   * sem saber o que já foi avisado. Sem isto a margem gerou ~17 sinais/produto/dia
   * (1.000+ em 3 dias pra 21 produtos — reclamação do dono 24/11/2026).
   * Chave = (analyzer, categoria, produto/entidade). Mudou a categoria (baixa → crítica)
   * = situação nova, avisa de novo.
   */
  private async soNovos(orgId: string, analyzer: string, drafts: SignalDraft[]): Promise<SignalDraft[]> {
    if (drafts.length === 0) return drafts
    const horas = JANELA_REPETICAO_H[analyzer] ?? 24
    const since = new Date(Date.now() - horas * 3_600_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('alert_signals')
      .select('category, entity_id, entity_name')
      .eq('organization_id', orgId)
      .eq('analyzer', analyzer)
      .gte('created_at', since)
      .limit(5000)
    if (error) {
      this.logger.warn(`[soNovos] ${analyzer}: ${error.message} — sem trava nesta rodada`)
      return []   // na dúvida, não repete
    }
    const chave = (c: string, id?: string | null, nome?: string | null) => `${c}|${id ?? ''}|${id ? '' : nome ?? ''}`
    const vistos = new Set((data ?? []).map((r: { category: string; entity_id: string | null; entity_name: string | null }) =>
      chave(r.category, r.entity_id, r.entity_name)))
    const out: SignalDraft[] = []
    for (const d of drafts) {
      const k = chave(d.category, d.entity_id, d.entity_name)
      if (vistos.has(k)) continue
      vistos.add(k)   // e não duplica dentro da mesma rodada
      out.push(d)
    }
    return out
  }

  /**
   * Registry estático — adicione novos analyzers aqui conforme implementam.
   * cross_intel não fica aqui pois CrossIntelService roda em cron próprio.
   */
  private registry(): Record<AnalyzerName, BaseAnalyzer | undefined> {
    return {
      estoque:      this.estoque,
      compras:      this.compras,
      preco:        undefined,        // PRC-2: PricingIntelligence é fonte
      margem:       this.margem,
      ads:          this.ads,
      cross_intel:  undefined,
      atendente_ia: undefined,        // AI-5: bridge inline em AiResponderService
      ia_saude:     undefined,
      farm:         undefined,        // FarmService.handleFailure emite direto        // IaSaudeWatchService tem cron próprio
      ml:           undefined,        // ML vertical (MVP 2 do Pós-venda) usa
                                       // services próprios (MlClaimsService,
                                       // MlReputationService, etc.) com cron
                                       // específico, não BaseAnalyzer scan-style.
    } as Record<AnalyzerName, BaseAnalyzer | undefined>
  }
}
