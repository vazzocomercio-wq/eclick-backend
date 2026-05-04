/**
 * Tipos compartilhados pelo Intelligence Hub.
 *
 * Cada analyzer (estoque, compras, preço, margem, ads) emite SignalDraft;
 * o AlertSignalsService persiste em alert_signals e o AlertEngine roteia
 * pra deliveries baseado em alert_routing_rules.
 */

export type AnalyzerName =
  | 'compras' | 'preco' | 'estoque' | 'margem' | 'ads' | 'cross_intel'

export type AlertSeverity = 'critical' | 'warning' | 'info'

export type AlertSignalStatus =
  | 'new' | 'dispatched' | 'delivered' | 'acted' | 'ignored' | 'expired'

export type AlertEntityType =
  | 'product' | 'order' | 'campaign' | 'supplier' | 'category' | null

/**
 * Draft emitido por um analyzer — sem id/status/created_at, que ficam por
 * conta do AlertSignalsService.
 */
export interface SignalDraft {
  analyzer:        AnalyzerName
  category:        string                  // e.g. 'ruptura_iminente', 'estoque_alto'
  severity:        AlertSeverity
  score:           number                  // 0..100
  entity_type?:    AlertEntityType
  entity_id?:      string | null
  entity_name?:    string | null
  data:            Record<string, unknown> // payload livre (numeros usados no calculo)
  summary_pt:      string                  // 1-3 frases pra exibir no card/whatsapp
  suggestion_pt?:  string | null           // sugestão de ação ("comprar 200u")
  expires_at?:     string | null           // ISO; quando o sinal vira irrelevante
}

export interface AlertSignal extends SignalDraft {
  id:              string
  organization_id: string
  status:          AlertSignalStatus
  related_signals: string[] | null
  cross_insight:   string | null
  created_at:      string
}

// ── Deliveries ────────────────────────────────────────────────────────────────

export type DeliveryChannel    = 'whatsapp' | 'email' | 'push' | 'dashboard'
export type DeliveryType       = 'immediate' | 'digest_morning' | 'digest_afternoon' | 'digest_evening'
export type DeliveryStatus     = 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
export type DeliveryResponse   = 'approve' | 'details' | 'ignore' | 'delegate' | 'custom'

export interface DeliveryDraft {
  organization_id: string
  signal_id:       string
  manager_id:      string
  channel?:        DeliveryChannel        // default 'whatsapp'
  delivery_type?:  DeliveryType           // default 'immediate'
}

export interface AlertDelivery {
  id:              string
  organization_id: string
  signal_id:       string
  manager_id:      string
  channel:         DeliveryChannel
  delivery_type:   DeliveryType
  status:          DeliveryStatus
  sent_at:         string | null
  delivered_at:    string | null
  read_at:         string | null
  error_message:   string | null
  response_type:   DeliveryResponse | null
  response_text:   string | null
  response_at:     string | null
  wa_message_id:   string | null
  created_at:      string
}

// ── Severity helpers ──────────────────────────────────────────────────────────

export function severityFromScore(score: number): AlertSeverity {
  if (score >= 80) return 'critical'
  if (score >= 50) return 'warning'
  return 'info'
}
