-- Customer Hub Parte 3/4 — Segmentação, Score LTV, Curva ABC
-- Adiciona colunas RFM/ABC/segmento em unified_customers, cria
-- customer_segments + customer_segment_members pra segmentos
-- configuráveis, e função compute_customer_metrics(org_id) que
-- recalcula tudo em batch (chamada pelo cron diário e endpoint manual).

-- 1) Score e métricas RFM por cliente
ALTER TABLE unified_customers
  ADD COLUMN IF NOT EXISTS rfm_recency_days   INT,
  ADD COLUMN IF NOT EXISTS rfm_frequency      INT,
  ADD COLUMN IF NOT EXISTS rfm_monetary       DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS rfm_score          DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS ltv_score          DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS abc_curve          TEXT
    CHECK (abc_curve IN ('A','B','C')),
  ADD COLUMN IF NOT EXISTS segment            TEXT,
  ADD COLUMN IF NOT EXISTS segment_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purchase_count     INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_ticket         DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS first_purchase_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_purchase_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS churn_risk         TEXT
    CHECK (churn_risk IN ('low','medium','high','critical'));

CREATE INDEX IF NOT EXISTS idx_unified_customers_abc
  ON unified_customers(organization_id, abc_curve);
CREATE INDEX IF NOT EXISTS idx_unified_customers_segment
  ON unified_customers(organization_id, segment);
CREATE INDEX IF NOT EXISTS idx_unified_customers_ltv
  ON unified_customers(organization_id, ltv_score DESC);

-- 2) Segmentos configuráveis
CREATE TABLE IF NOT EXISTS customer_segments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  color            TEXT DEFAULT '#00E5FF',
  icon             TEXT DEFAULT '👥',
  rules            JSONB NOT NULL DEFAULT '[]',
  -- rule: { field, operator, value }
  -- fields: abc_curve, churn_risk, total_purchases,
  --   purchase_count, rfm_score, has_cpf, is_vip,
  --   last_purchase_days, avg_ticket
  -- operators: eq, gt, lt, gte, lte, in, not_in
  customer_count   INT DEFAULT 0,
  auto_refresh     BOOLEAN DEFAULT true,
  last_computed_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_segment_members (
  segment_id  UUID REFERENCES customer_segments(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES unified_customers(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (segment_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_seg_members_customer
  ON customer_segment_members(customer_id);

ALTER TABLE customer_segments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_segment_members ENABLE ROW LEVEL SECURITY;
GRANT ALL ON customer_segments        TO service_role;
GRANT ALL ON customer_segment_members TO service_role;

DROP POLICY IF EXISTS srv_segments    ON customer_segments;
DROP POLICY IF EXISTS srv_seg_members ON customer_segment_members;
CREATE POLICY srv_segments ON customer_segments
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_seg_members ON customer_segment_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3) Função SQL para calcular RFM + ABC + churn + segmento em batch
CREATE OR REPLACE FUNCTION compute_customer_metrics(p_org_id UUID)
RETURNS void AS $$
DECLARE
  v_total_revenue DECIMAL;
  v_80pct_revenue DECIMAL;
  v_95pct_revenue DECIMAL;
BEGIN
  -- 1. Atualizar métricas base de cada cliente
  UPDATE unified_customers uc
  SET
    purchase_count    = sub.cnt,
    total_purchases   = sub.total,
    avg_ticket        = sub.avg_t,
    first_purchase_at = sub.first_p,
    last_purchase_at  = sub.last_p,
    rfm_recency_days  = EXTRACT(DAY FROM now() - sub.last_p)::INT,
    rfm_frequency     = sub.cnt,
    rfm_monetary      = sub.total,
    updated_at        = now()
  FROM (
    SELECT
      raw_data->'buyer'->>'id' AS ml_buyer_id,
      COUNT(*)         AS cnt,
      SUM(sale_price)  AS total,
      AVG(sale_price)  AS avg_t,
      MIN(sold_at)     AS first_p,
      MAX(sold_at)     AS last_p
    FROM orders
    WHERE organization_id = p_org_id
      AND status NOT IN ('cancelled','refunded')
      AND sold_at IS NOT NULL
    GROUP BY raw_data->'buyer'->>'id'
  ) sub
  WHERE uc.organization_id = p_org_id
    AND uc.ml_buyer_id = sub.ml_buyer_id;

  -- 2. Score RFM (0-10, média ponderada R30%/F30%/M40%)
  UPDATE unified_customers
  SET rfm_score = (
    (1 - LEAST(rfm_recency_days, 365) / 365.0) * 10 * 0.3
    + LEAST(rfm_frequency, 10) / 10.0 * 10 * 0.3
    + CASE WHEN (SELECT MAX(rfm_monetary) FROM unified_customers
                 WHERE organization_id = p_org_id) > 0
      THEN rfm_monetary / (SELECT MAX(rfm_monetary) FROM unified_customers
                           WHERE organization_id = p_org_id) * 10
      ELSE 0 END * 0.4
  )
  WHERE organization_id = p_org_id
    AND rfm_recency_days IS NOT NULL;

  -- 3. LTV score (monetary × multiplicador de recência)
  UPDATE unified_customers
  SET ltv_score = COALESCE(rfm_monetary, 0) *
    CASE
      WHEN rfm_recency_days <= 30  THEN 1.5
      WHEN rfm_recency_days <= 90  THEN 1.2
      WHEN rfm_recency_days <= 180 THEN 1.0
      ELSE 0.7
    END
  WHERE organization_id = p_org_id;

  -- 4. Curva ABC (Pareto 80/95)
  SELECT SUM(total_purchases) INTO v_total_revenue
  FROM unified_customers
  WHERE organization_id = p_org_id;

  v_80pct_revenue := v_total_revenue * 0.80;
  v_95pct_revenue := v_total_revenue * 0.95;

  WITH ranked AS (
    SELECT id,
      SUM(total_purchases) OVER (
        ORDER BY total_purchases DESC
        ROWS UNBOUNDED PRECEDING
      ) AS cumulative
    FROM unified_customers
    WHERE organization_id = p_org_id
  )
  UPDATE unified_customers uc
  SET abc_curve = CASE
    WHEN r.cumulative <= v_80pct_revenue THEN 'A'
    WHEN r.cumulative <= v_95pct_revenue THEN 'B'
    ELSE 'C'
  END
  FROM ranked r
  WHERE uc.id = r.id
    AND uc.organization_id = p_org_id;

  -- 5. Churn risk
  UPDATE unified_customers
  SET churn_risk = CASE
    WHEN rfm_recency_days <= 30  THEN 'low'
    WHEN rfm_recency_days <= 90  THEN 'medium'
    WHEN rfm_recency_days <= 180 THEN 'high'
    ELSE 'critical'
  END
  WHERE organization_id = p_org_id
    AND rfm_recency_days IS NOT NULL;

  -- 6. Segmento automático baseado em RFM
  UPDATE unified_customers
  SET segment = CASE
    WHEN rfm_score >= 8 THEN 'campeoes'
    WHEN rfm_score >= 6 AND rfm_frequency >= 3 THEN 'leais'
    WHEN rfm_score >= 6 AND rfm_recency_days <= 30 THEN 'promissores'
    WHEN rfm_recency_days <= 30 AND rfm_frequency = 1 THEN 'novos'
    WHEN rfm_recency_days > 180 AND rfm_monetary > 0 THEN 'em_risco'
    WHEN rfm_recency_days > 365 THEN 'perdidos'
    ELSE 'ocasionais'
  END,
  segment_updated_at = now()
  WHERE organization_id = p_org_id;
END;
$$ LANGUAGE plpgsql;
