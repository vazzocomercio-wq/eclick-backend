-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 11 — Score do Parceiro v1
-- ════════════════════════════════════════════════════════════════════════
-- Histórico mensal de score (0-100). v1 com 5 dimensões (cada 0-20):
--   - stock_accuracy:        % SKUs ativos sem stockout
--   - ship_lead_compliance:  % pedidos despachados no prazo
--   - divergence_rate:       inverso da taxa de divergências (Sprint 12)
--   - return_rate:           inverso da taxa de devolução
--   - approval_speed:        rapidez de aprovação de OC pelo parceiro
--
-- Total = soma das 5 dimensões → 0-100.
--
-- v2 adiciona: price_update_speed, sac_responsiveness, scalability,
-- delay_rate_inverse, communication.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dropship_partner_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  -- Período
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Score total (0-100)
  total_score INTEGER NOT NULL CHECK (total_score >= 0 AND total_score <= 100),

  -- Breakdown por dimensão (cada 0-20 na v1)
  score_breakdown JSONB NOT NULL,
  -- {
  --   "stock_accuracy": 18,
  --   "ship_lead_compliance": 16,
  --   "divergence_rate": 20,
  --   "return_rate": 17,
  --   "approval_speed": 19
  -- }

  -- Métricas brutas usadas no cálculo
  raw_metrics JSONB NOT NULL,
  -- {
  --   "active_skus": 50, "out_of_stock_skus": 2,
  --   "orders_processed": 432, "orders_delayed": 12,
  --   "returns_count": 8, "return_rate_pct": 1.85,
  --   "divergences_count": 3,
  --   "ocs_sent": 12, "ocs_approved": 11, "avg_approval_hours": 18
  -- }

  -- Insights gerados (placeholder pra IA do Sprint 12)
  insights JSONB DEFAULT '[]',

  -- Comparação período anterior
  prev_score INTEGER,
  score_change INTEGER,

  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_scores_supplier
  ON dropship_partner_scores(supplier_id);
CREATE INDEX IF NOT EXISTS idx_partner_scores_period
  ON dropship_partner_scores(period_end DESC);
-- Idempotência: 1 score por supplier por período
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_scores_unique
  ON dropship_partner_scores(supplier_id, period_start, period_end);

GRANT ALL ON TABLE public.dropship_partner_scores TO service_role;
GRANT SELECT ON TABLE public.dropship_partner_scores TO authenticated;
