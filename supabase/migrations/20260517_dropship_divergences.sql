-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 12 — Detecção de Divergências
-- ════════════════════════════════════════════════════════════════════════
-- Tabela armazena divergências detectadas automaticamente via regras
-- (cron @02h) e via análise inline (geração de OC, sync de catálogo).
--
-- 9 tipos:
--   - cost_change_uninformed: cost subiu >5% no supplier_products sem aviso
--   - cost_at_oc_different:   item de OC com custo divergente do contratado
--   - stock_inconsistency:    vendeu N mas partner_stock < N
--   - shipment_delay:         identification > 48h sem shipped_at
--   - no_shipment_confirmation: ML diz shipped mas parceiro não confirmou
--   - return_amount_mismatch: valor da devolução divergente do esperado
--   - duplicate_oc_item:      mesmo identification em 2+ OCs (não acontece se
--                             UNIQUE constraint funcionar, mas check defensivo)
--   - missing_partner_product: identification on_hold por sem supplier_product
--   - price_below_cost:       price ML < unit_cost (margem negativa)
--
-- 4 severities: critical/high/medium/low.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dropship_divergences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),

  divergence_type TEXT NOT NULL CHECK (divergence_type IN (
    'cost_change_uninformed', 'cost_at_oc_different', 'stock_inconsistency',
    'shipment_delay', 'no_shipment_confirmation', 'return_amount_mismatch',
    'duplicate_oc_item', 'missing_partner_product', 'price_below_cost'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),

  -- Referências polimórficas
  identification_id UUID REFERENCES dropship_order_identifications(id),
  supplier_product_id UUID REFERENCES supplier_products(id),
  oc_id UUID REFERENCES dropship_purchase_orders(id),
  oc_item_id UUID REFERENCES dropship_purchase_order_items(id),

  -- Detalhes do desvio
  expected_value NUMERIC,
  actual_value NUMERIC,
  difference_amount NUMERIC,
  difference_pct NUMERIC,
  description TEXT NOT NULL,
  context JSONB DEFAULT '{}',

  -- Ação recomendada
  recommended_action TEXT,

  -- Status
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'acknowledged', 'investigating', 'resolved', 'ignored'
  )),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id),
  resolution_notes TEXT,

  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_divergences_org ON dropship_divergences(organization_id);
CREATE INDEX IF NOT EXISTS idx_divergences_supplier ON dropship_divergences(supplier_id);
CREATE INDEX IF NOT EXISTS idx_divergences_status ON dropship_divergences(status)
  WHERE status IN ('open', 'acknowledged', 'investigating');
CREATE INDEX IF NOT EXISTS idx_divergences_severity ON dropship_divergences(severity);
CREATE INDEX IF NOT EXISTS idx_divergences_detected ON dropship_divergences(detected_at DESC);

-- Idempotência: evita duplicar divergência aberta pra mesma referência
CREATE UNIQUE INDEX IF NOT EXISTS idx_divergences_unique_open
  ON dropship_divergences(divergence_type, COALESCE(identification_id::text, ''),
                          COALESCE(supplier_product_id::text, ''),
                          COALESCE(oc_item_id::text, ''))
  WHERE status IN ('open', 'acknowledged', 'investigating');

GRANT ALL ON TABLE public.dropship_divergences TO service_role;
GRANT SELECT, UPDATE ON TABLE public.dropship_divergences TO authenticated;
