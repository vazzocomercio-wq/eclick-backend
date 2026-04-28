-- Pricing Intelligence Sprint P1/5 — Configuração e Parâmetros editáveis
-- 4 tabelas: config (1 por org), audit (mudanças), seasonal (períodos),
-- untouchable_sellers (blocklist). RLS service_role-only.

CREATE TABLE IF NOT EXISTS pricing_intelligence_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE,
  global_params JSONB NOT NULL DEFAULT '{
    "min_margin_absolute_pct": 20,
    "target_margin_pct": 35,
    "priority_channel": "mercadolivre",
    "desired_position": 3,
    "avg_replenishment_days": 45,
    "min_stock_coverage_days": 15,
    "critical_stock_days": 7
  }'::jsonb,
  abc_strategies JSONB NOT NULL DEFAULT '{
    "A": {"min_margin_pct": 35, "max_discount_pct":  8, "approval_threshold_pct":  3, "require_approval": true,  "priority": "maintain_position"},
    "B": {"min_margin_pct": 25, "max_discount_pct": 15, "approval_threshold_pct":  5, "require_approval": false, "priority": "balanced"},
    "C": {"min_margin_pct": 15, "max_discount_pct": 25, "approval_threshold_pct": 10, "require_approval": false, "priority": "aggressive_turnover"}
  }'::jsonb,
  triggers JSONB NOT NULL DEFAULT '{
    "decrease_price": [
      {"id": "ctr_drop",          "active": true,  "params": {"drop_pct": 20, "days": 7},  "label": "CTR caiu mais que X% em Y dias E concorrente mais barato"},
      {"id": "stale_stock",       "active": true,  "params": {"days_no_sale": 45},          "label": "Estoque parado por X dias sem venda"},
      {"id": "curve_c_overstock", "active": true,  "params": {"coverage_days": 90},         "label": "Curva C com cobertura > X dias"},
      {"id": "low_position",      "active": false, "params": {"position": 5, "days": 3},    "label": "Posição no canal > X por Y dias"}
    ],
    "increase_price": [
      {"id": "low_coverage",   "active": true, "params": {"days": 10},                "label": "Cobertura < X dias sem compra em andamento"},
      {"id": "competitor_oos", "active": true, "params": {},                          "label": "Concorrente principal esgotado"},
      {"id": "growing_demand", "active": true, "params": {"growth_pct": 15},          "label": "Demanda crescendo > X% semana a semana"},
      {"id": "high_roas",      "active": true, "params": {"roas": 5, "days": 3},      "label": "ROAS > X por Y dias consecutivos"}
    ],
    "do_not_touch": [
      {"id": "incoming_purchase", "active": true, "params": {"days": 15},      "label": "Compra chegando em < X dias"},
      {"id": "recent_change",     "active": true, "params": {"days": 3},       "label": "Mudança nos últimos X dias"},
      {"id": "active_ads",        "active": true, "params": {"min_roas": 3},   "label": "Em campanha Ads com ROAS > X"},
      {"id": "low_stock_safe",    "active": true, "params": {"units": 5},      "label": "Estoque < X unidades (modo conservador)"}
    ]
  }'::jsonb,
  absolute_blocks JSONB NOT NULL DEFAULT '{
    "never_below_cost": true,
    "max_change_per_run_pct": 10,
    "require_cost_data": true,
    "max_changes_per_day_per_product": 2
  }'::jsonb,
  confidence_rules JSONB NOT NULL DEFAULT '{
    "min_for_auto_action": 75,
    "min_for_suggestion": 50,
    "penalties": {
      "no_cost_data":           30,
      "no_sales_history":       20,
      "no_competitor_data":     25,
      "new_product_under_30d":  15,
      "stale_data_over_48h":    10
    }
  }'::jsonb,
  custom_rules JSONB NOT NULL DEFAULT '{
    "seasonal_categories":     [],
    "untouchable_sellers":     [],
    "category_special_rules":  []
  }'::jsonb,
  mode TEXT DEFAULT 'suggestion_only' CHECK (mode IN (
    'disabled','suggestion_only','auto_with_limits','full_auto'
  )),
  preset_name TEXT,
  chat_enabled BOOLEAN DEFAULT true,
  chat_model   TEXT DEFAULT 'claude-sonnet-4-5',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_config_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  config_id       UUID REFERENCES pricing_intelligence_config(id),
  field_path      TEXT NOT NULL,
  old_value       JSONB,
  new_value       JSONB,
  changed_by      UUID,
  change_reason   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_seasonal_periods (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL,
  name                   TEXT NOT NULL,
  category               TEXT,
  start_date             DATE NOT NULL,
  end_date               DATE NOT NULL,
  pricing_adjustment_pct DECIMAL(5,2),
  margin_override_pct    DECIMAL(5,2),
  notes                  TEXT,
  is_active              BOOLEAN DEFAULT true,
  recurring_yearly       BOOLEAN DEFAULT false,
  created_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_untouchable_sellers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL,
  seller_name        TEXT NOT NULL,
  seller_id_external TEXT,
  channel            TEXT CHECK (channel IN ('mercadolivre','shopee','amazon','magalu','all')),
  reason             TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pri_config_org
  ON pricing_intelligence_config(organization_id);
CREATE INDEX IF NOT EXISTS idx_pri_audit_config
  ON pricing_config_audit(config_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pri_seasonal_active
  ON pricing_seasonal_periods(organization_id, is_active, start_date);
CREATE INDEX IF NOT EXISTS idx_pri_untouchable_org
  ON pricing_untouchable_sellers(organization_id, channel);

ALTER TABLE pricing_intelligence_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_config_audit         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_seasonal_periods     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_untouchable_sellers  ENABLE ROW LEVEL SECURITY;

GRANT ALL ON pricing_intelligence_config  TO service_role;
GRANT ALL ON pricing_config_audit         TO service_role;
GRANT ALL ON pricing_seasonal_periods     TO service_role;
GRANT ALL ON pricing_untouchable_sellers  TO service_role;

DROP POLICY IF EXISTS srv_pri_config       ON pricing_intelligence_config;
DROP POLICY IF EXISTS srv_pri_audit        ON pricing_config_audit;
DROP POLICY IF EXISTS srv_pri_seasonal     ON pricing_seasonal_periods;
DROP POLICY IF EXISTS srv_pri_untouchable  ON pricing_untouchable_sellers;

CREATE POLICY srv_pri_config       ON pricing_intelligence_config  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_pri_audit        ON pricing_config_audit         FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_pri_seasonal     ON pricing_seasonal_periods     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_pri_untouchable  ON pricing_untouchable_sellers  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO pricing_intelligence_config (organization_id, preset_name)
VALUES ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'equilibrado')
ON CONFLICT (organization_id) DO NOTHING;

INSERT INTO pricing_seasonal_periods
  (organization_id, name, start_date, end_date,
   pricing_adjustment_pct, margin_override_pct,
   notes, recurring_yearly)
VALUES (
  '4ef1aabd-c209-40b0-b034-ef69dcb66833',
  'Black Friday',
  '2026-11-25',
  '2026-12-01',
  -15,
  20,
  'Período Black Friday + Cyber Monday. Permitir margem reduzida temporariamente para volume.',
  true
)
ON CONFLICT DO NOTHING;
