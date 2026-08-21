import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import {
  BUILTIN_RULE_SETS, isValidRuleSetConfig, resolveRuleSet, resolveUpcomingRuleSet,
} from './ml-reputation.rules'
import type { ReputationRuleSet } from './ml-reputation.types'

interface RuleSetRow {
  id:              string
  marketplace:     string
  name:            string
  effective_from:  string | null
  effective_until: string | null
  config:          unknown
  is_builtin:      boolean
  notes:           string | null
}

const CACHE_TTL_MS = 5 * 60 * 1000
const MARKETPLACE  = 'MERCADO_LIVRE'

/**
 * Carrega os conjuntos de regras da tabela `ml_reputation_rule_sets`
 * (cache de 5 min) e resolve qual vale numa data. Linha do banco com o
 * mesmo nome de uma regra embutida SOBRESCREVE a embutida — é assim que
 * se ajusta um limite sem deploy. Config inválido é ignorado com log
 * (a regra embutida continua valendo) em vez de derrubar o cálculo.
 */
@Injectable()
export class MlReputationRulesService {
  private readonly logger = new Logger(MlReputationRulesService.name)
  private cache: { loadedAt: number; sets: ReputationRuleSet[] } | null = null

  async listRuleSets(force = false): Promise<ReputationRuleSet[]> {
    if (!force && this.cache && Date.now() - this.cache.loadedAt < CACHE_TTL_MS) return this.cache.sets

    const byName = new Map<string, ReputationRuleSet>()
    for (const b of BUILTIN_RULE_SETS) byName.set(b.name, b)

    try {
      const { data, error } = await supabaseAdmin
        .from('ml_reputation_rule_sets')
        .select('id, marketplace, name, effective_from, effective_until, config, is_builtin, notes')
        .eq('marketplace', MARKETPLACE)
      if (error) throw new Error(error.message)
      for (const row of (data ?? []) as RuleSetRow[]) {
        if (!isValidRuleSetConfig(row.config)) {
          this.logger.warn(`[rules] regra "${row.name}" com config inválido no banco — ignorada (usando embutida se existir)`)
          continue
        }
        byName.set(row.name, {
          id:             row.id,
          marketplace:    row.marketplace,
          name:           row.name,
          effectiveFrom:  row.effective_from,
          effectiveUntil: row.effective_until,
          config:         row.config,
          isBuiltin:      row.is_builtin,
          notes:          row.notes,
        })
      }
    } catch (err) {
      this.logger.warn(`[rules] falha ao ler ml_reputation_rule_sets (${(err as Error).message}) — usando regras embutidas`)
    }

    const sets = [...byName.values()]
    this.cache = { loadedAt: Date.now(), sets }
    return sets
  }

  /** Regra vigente na data civil (YYYY-MM-DD, America/Sao_Paulo). */
  async getActive(date: string): Promise<ReputationRuleSet> {
    return resolveRuleSet(await this.listRuleSets(), date)
  }

  /** Próxima regra ainda não vigente (pra "Simulação das regras de 10/09/2026"). */
  async getUpcoming(date: string): Promise<ReputationRuleSet | null> {
    return resolveUpcomingRuleSet(await this.listRuleSets(), date)
  }

  async getByName(name: string): Promise<ReputationRuleSet | null> {
    return (await this.listRuleSets()).find(r => r.name === name) ?? null
  }

  invalidate(): void {
    this.cache = null
  }
}
