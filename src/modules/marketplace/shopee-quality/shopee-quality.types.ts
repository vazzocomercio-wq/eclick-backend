/** F18 F1.3 — Tipos do Shopee Quality Center.
 *
 *  Métricas de saúde da loja (shop-level, não anúncio-level). Snapshot
 *  diário em shopee.shop_metrics; UI cockpit lê o mais recente + tendência.
 *
 *  ⚠️ Algumas métricas (chat_response_rate, prep_time_days) NÃO vêm
 *  diretamente da Open Platform API — vão precisar de F12 Chrome Extension
 *  scraping na Sprint 2. Por ora a tabela aceita NULL e o cockpit mostra
 *  "—" pra esses campos. */

export type HealthStatus =
  | 'healthy'        // tudo dentro dos limites
  | 'attention'      // 1+ métrica em zona de atenção
  | 'warning'        // 1+ métrica em zona de aviso (precisa ação)
  | 'critical'       // risco grave de suspensão (penalty >= 6 ou similar)

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface ShopMetricsSnapshot {
  /** Identificação */
  shop_id:                 number
  organization_id:         string
  snapshot_date:           string                // YYYY-MM-DD

  /** Chat */
  chat_response_rate?:     number | null         // 0-1
  chat_response_time_min?: number | null         // minutos

  /** Logística */
  prep_time_days?:         number | null
  late_ship_rate?:         number | null         // 0-1

  /** Pós-venda */
  return_refund_rate?:     number | null         // 0-1
  rating?:                 number | null         // 0-5

  /** Compliance */
  penalty_points?:         number | null         // 0..N (Shopee BR 6+ = suspensão)

  /** Raw (debug) */
  raw?:                    Record<string, unknown> | null

  /** Source da medição */
  source?:                 'api' | 'extension' | 'manual' | null
}

export interface ShopMetricAlert {
  /** Severidade — controla cor + ação */
  severity:           AlertSeverity
  /** Código único pro alerta — dedup + i18n key */
  code:               string
  /** Descrição humana (PT-BR) */
  description:        string
  /** Ação sugerida ao lojista */
  recommended_action: string
  /** Métrica responsável (debug) */
  metric:             keyof Omit<ShopMetricsSnapshot, 'shop_id' | 'organization_id' | 'snapshot_date' | 'raw' | 'source'>
  current_value?:     number | string
  target_value?:      number | string
}

export interface ShopHealthCard {
  shop_id:        number
  shop_name?:     string | null
  snapshot_date:  string
  status:         HealthStatus
  metrics:        ShopMetricsSnapshot
  alerts:         ShopMetricAlert[]
  /** Quantos campos da snapshot estão preenchidos (transparência ao
   *  cockpit — UI mostra "X/7 métricas disponíveis"). */
  completeness:   { filled: number; total: number }
}

/** Thresholds — ajustáveis sem deploy via env (futuro). Centralizado pra
 *  poder espelhar em UI/docs sem desincronizar. */
export const QUALITY_THRESHOLDS = {
  chat_response_rate:     { warning: 0.85, critical: 0.70 },
  chat_response_time_min: { warning: 60,   critical: 240  },
  prep_time_days:         { warning: 2,    critical: 3    },
  late_ship_rate:         { warning: 0.05, critical: 0.10 },
  return_refund_rate:     { warning: 0.05, critical: 0.10 },
  rating:                 { warning: 4.5,  critical: 4.0  }, // inverso (>= bom)
  penalty_points:         { warning: 3,    critical: 6    }, // Shopee BR cravado: 6 = ameaça
} as const
