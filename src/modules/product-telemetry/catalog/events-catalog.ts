/**
 * Catálogo canônico de telemetria — e-Click Insights.
 *
 * Esta é a fonte da verdade. Evento que não está aqui é rejeitado na ingestão
 * (vira lixo silencioso senão). Ao instrumentar um módulo novo, adicione a
 * chave aqui PRIMEIRO. Padrão da chave: `<modulo>.<acao>` (snake/dot).
 */

export const TELEMETRY_EVENTS = {
  // ===== Navegação =====
  PAGE_VIEW:        'page_view',
  MODULE_ENTERED:   'module_entered',
  MODULE_EXITED:    'module_exited',

  // ===== F11 Dashboard =====
  DASHBOARD_KPI_VIEWED:    'dashboard.kpi_viewed',
  DASHBOARD_DRILL_DOWN:    'dashboard.drill_down',
  DASHBOARD_PERIOD_CHANGED:'dashboard.period_changed',

  // ===== F8 Campaign Center =====
  CAMPAIGN_CREATED:        'campaign.created',
  CAMPAIGN_PUBLISHED:      'campaign.published',
  CAMPAIGN_PRICE_SUGGESTED:'campaign.price_suggested',
  CAMPAIGN_AI_ACCEPTED:    'campaign.ai_suggestion_accepted',
  CAMPAIGN_AI_REJECTED:    'campaign.ai_suggestion_rejected',

  // ===== F10 Listing Center =====
  LISTING_VIEWED:          'listing.viewed',
  LISTING_EDITED:          'listing.edited',
  LISTING_QUALITY_CHECKED: 'listing.quality_checked',
  LISTING_BUYBOX_VIEWED:   'listing.buybox_viewed',

  // ===== F7 ML Quality Center =====
  QUALITY_REPORT_OPENED:   'quality.report_opened',
  QUALITY_ISSUE_RESOLVED:  'quality.issue_resolved',

  // ===== F9 Dropship Center =====
  DROPSHIP_SUPPLIER_VIEWED:'dropship.supplier_viewed',
  DROPSHIP_PRODUCT_IMPORTED:'dropship.product_imported',

  // ===== F6 IA Criativo =====
  CREATIVE_GENERATED:      'creative.generated',
  CREATIVE_DOWNLOADED:     'creative.downloaded',
  CREATIVE_PUBLISHED:      'creative.published',

  // ===== Radar IA =====
  RADAR_OPPORTUNITY_VIEWED:'radar.opportunity_viewed',
  RADAR_OPPORTUNITY_ACTED: 'radar.opportunity_acted',

  // ===== Customer Intelligence Hub =====
  CUSTOMER_SEARCHED:       'customer.searched',
  CUSTOMER_ENRICHED:       'customer.enriched',

  // ===== Active CRM (instrumentação adiada pro v2 — chaves reservadas) =====
  ACTIVE_INBOX_OPENED:     'active.inbox_opened',
  ACTIVE_MESSAGE_SENT:     'active.message_sent',
  ACTIVE_COPILOT_USED:     'active.copilot_used',

  // ===== Tasks (funnels) =====
  TASK_STARTED:            'task.started',
  TASK_COMPLETED:          'task.completed',
  TASK_ABANDONED:          'task.abandoned',

  // ===== AI Visibility — GEO Score (ciclo de auditoria, emitidos pelo backend) =====
  GEO_SCORE_AUDIT_QUEUED:        'geo_score.audit_queued',
  GEO_SCORE_PROCESSING_STARTED:  'geo_score.processing_started',
  GEO_SCORE_PROCESSING_COMPLETED:'geo_score.processing_completed',
  GEO_SCORE_PROCESSING_FAILED:   'geo_score.processing_failed',
  GEO_SCORE_RETRY_SCHEDULED:     'geo_score.retry_scheduled',
  GEO_SCORE_CACHE_HIT:           'geo_score.cache_hit',
  GEO_SCORE_CACHE_BYPASSED:      'geo_score.cache_bypassed',
  GEO_SCORE_RECOMMENDATION_CLICKED: 'geo_score.recommendation_clicked',
  GEO_SCORE_AUDIT_SKIPPED:          'geo_score.audit_skipped',

  // ===== AI Visibility — geo-optimizer =====
  GEO_OPTIMIZER_GENERATION_REQUESTED: 'geo_optimizer.generation_requested',
  GEO_OPTIMIZER_VARIATION_SELECTED:   'geo_optimizer.variation_selected',
  GEO_OPTIMIZER_APPLIED:              'geo_optimizer.applied_to_marketplace',
  GEO_OPTIMIZER_ROLLED_BACK:          'geo_optimizer.rolled_back',
  GEO_OPTIMIZER_IMPACT_MEASURED:      'geo_optimizer.impact_measured',
} as const

export const MODULES = {
  DASHBOARD:   'dashboard',
  CAMPAIGNS:   'campaigns',
  LISTINGS:    'listings',
  QUALITY:     'quality',
  DROPSHIP:    'dropship',
  CREATIVE:    'creative',
  RADAR:       'radar',
  CUSTOMERS:   'customers',
  ACTIVE_CRM:  'active_crm',
  ADS:         'ads',
  ENRICHMENT:  'enrichment',
  PRICING:     'pricing',
  SETTINGS:    'settings',
  AI_VISIBILITY: 'ai_visibility',
} as const

export const TRACKED_TASKS = {
  CREATE_CAMPAIGN:     'create_campaign',     // F8: abrir → publicar
  IMPORT_LISTING:      'import_listing',       // F10: catálogo ML → salvar
  ENRICH_CUSTOMER:     'enrich_customer',      // Hub: busca → CPF
  GENERATE_CREATIVE:   'generate_creative',    // F6: brief → download
  ONBOARD_USER:        'onboard_user',         // signup → primeira ação
  CONNECT_MARKETPLACE: 'connect_marketplace',  // OAuth start → concluído
} as const

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[keyof typeof TELEMETRY_EVENTS]
export type TelemetryModule    = (typeof MODULES)[keyof typeof MODULES]
export type TrackedTask        = (typeof TRACKED_TASKS)[keyof typeof TRACKED_TASKS]

/** Sets pra validação O(1) na ingestão. */
export const EVENT_NAME_SET = new Set<string>(Object.values(TELEMETRY_EVENTS))
export const MODULE_SET     = new Set<string>(Object.values(MODULES))

export const isValidEventName = (name: unknown): name is TelemetryEventName =>
  typeof name === 'string' && EVENT_NAME_SET.has(name)

export const isValidModule = (module: unknown): module is TelemetryModule =>
  typeof module === 'string' && MODULE_SET.has(module)
