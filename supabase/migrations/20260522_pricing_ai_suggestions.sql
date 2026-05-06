-- ============================================================
-- Onda 4 / A1 — Precificação Inteligente (IA)
-- Tabelas:
--   pricing_ai_suggestions  — sugestões pendentes/aplicadas por produto
--   pricing_ai_rules        — config global de regras por org
-- Naming: pricing_ai_* pra não colidir com pricing_intelligence_*
-- (sistema antigo de ML competitive pricing).
-- ============================================================

CREATE TABLE IF NOT EXISTS pricing_ai_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id)      ON DELETE CASCADE,

  -- Preço atual vs sugerido
  current_price    NUMERIC NOT NULL,
  suggested_price  NUMERIC NOT NULL,
  price_change_pct NUMERIC,
  price_direction  TEXT CHECK (price_direction IN ('increase','decrease','maintain')),

  -- Análise + cenários
  analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {
  --   factors: { cost_price, current_margin_pct, suggested_margin_pct,
  --              competitor_avg_price, competitor_min_price, competitor_max_price,
  --              stock_level, stock_days_remaining, sales_velocity_30d,
  --              sales_velocity_trend, abc_class, seasonality_factor,
  --              marketplace_commission_pct, shipping_avg_cost,
  --              ads_cpa, conversion_rate },
  --   reasoning: string,
  --   confidence: 0-1,
  --   scenarios: {
  --     conservative: { price, expected_margin, expected_sales_change },
  --     optimal:      { price, expected_margin, expected_sales_change },
  --     aggressive:   { price, expected_margin, expected_sales_change }
  --   }
  -- }

  rules_applied JSONB NOT NULL DEFAULT '[]'::jsonb,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','approved','rejected','applied','expired','auto_applied'
  )),
  applied_at        TIMESTAMPTZ,
  applied_price     NUMERIC,
  rejection_reason  TEXT,

  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_ai_sug_org      ON pricing_ai_suggestions(organization_id);
CREATE INDEX IF NOT EXISTS idx_pricing_ai_sug_product  ON pricing_ai_suggestions(product_id);
CREATE INDEX IF NOT EXISTS idx_pricing_ai_sug_pending  ON pricing_ai_suggestions(organization_id, status)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pricing_ai_sug_created  ON pricing_ai_suggestions(created_at);

-- Config de regras por org
CREATE TABLE IF NOT EXISTS pricing_ai_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

  min_margin_pct           NUMERIC NOT NULL DEFAULT 20,
  max_discount_pct         NUMERIC NOT NULL DEFAULT 30,
  price_rounding           TEXT    NOT NULL DEFAULT 'x.90'
                             CHECK (price_rounding IN ('x.90','x.99','x.00','none')),
  auto_apply_enabled       BOOLEAN NOT NULL DEFAULT false,
  auto_apply_max_change_pct NUMERIC NOT NULL DEFAULT 5,

  -- Regras situacionais (livres em JSONB)
  rules JSONB NOT NULL DEFAULT '[]'::jsonb,

  analysis_frequency TEXT NOT NULL DEFAULT 'weekly'
    CHECK (analysis_frequency IN ('daily','weekly','biweekly','monthly','manual')),
  last_analysis_at  TIMESTAMPTZ,
  next_analysis_at  TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.set_pricing_ai_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pricing_ai_rules_updated ON pricing_ai_rules;
CREATE TRIGGER trg_pricing_ai_rules_updated
  BEFORE UPDATE ON pricing_ai_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_pricing_ai_updated_at();

-- RLS
ALTER TABLE pricing_ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_ai_rules       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pricing_ai_sug_select ON pricing_ai_suggestions;
CREATE POLICY pricing_ai_sug_select ON pricing_ai_suggestions FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS pricing_ai_sug_modify ON pricing_ai_suggestions;
CREATE POLICY pricing_ai_sug_modify ON pricing_ai_suggestions FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS pricing_ai_rules_select ON pricing_ai_rules;
CREATE POLICY pricing_ai_rules_select ON pricing_ai_rules FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS pricing_ai_rules_modify ON pricing_ai_rules;
CREATE POLICY pricing_ai_rules_modify ON pricing_ai_rules FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
