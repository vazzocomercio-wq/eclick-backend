-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 10 — Disputas
-- ════════════════════════════════════════════════════════════════════════
-- Disputa ≠ Devolução. Modelos:
--   - dropship_returns        → comprador devolve, sistema gera crédito
--   - dropship_disputes       → parceiro/seller CONTESTAM (custo divergente,
--     responsabilidade, valor de crédito, etc.)
--
-- Tipos:
--   - cost_divergence: parceiro alega que custo na OC está errado
--   - responsibility: quem absorve devolução (partner vs seller)
--   - amount: valor do crédito divergente
--   - product_returned: parceiro alega não receber produto devolvido
--   - item_inclusion: item não deveria estar na OC
--   - other
--
-- Workflow:
--   open → in_review → resolved_(partner|seller|compromise) → closed
--   ou escalated (jurídico/manual)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dropship_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),

  -- Referências (qualquer combinação faz sentido)
  return_id UUID REFERENCES dropship_returns(id),
  oc_item_id UUID REFERENCES dropship_purchase_order_items(id),
  oc_id UUID REFERENCES dropship_purchase_orders(id),

  -- Tipo
  dispute_type TEXT NOT NULL CHECK (dispute_type IN (
    'cost_divergence',     -- Custo divergente
    'responsibility',      -- Quem absorve
    'amount',              -- Valor do crédito
    'product_returned',    -- Parceiro alega não receber
    'item_inclusion',      -- Item não deveria estar na OC
    'other'
  )),

  -- Partes
  claimed_by TEXT NOT NULL CHECK (claimed_by IN ('seller', 'partner')),
  claimed_by_name TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Valores em disputa
  amount_claimed NUMERIC,
  amount_partner_accepts NUMERIC,
  amount_seller_proposes NUMERIC,
  final_resolved_amount NUMERIC,

  -- Descrição
  reason TEXT NOT NULL,
  description TEXT,
  evidence_urls TEXT[] DEFAULT '{}',

  -- Resolução
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',
    'in_review',
    'mediation',
    'resolved_partner',     -- A favor do parceiro
    'resolved_seller',      -- A favor do seller
    'resolved_compromise',  -- Acordo intermediário
    'escalated',            -- Jurídico
    'closed'
  )),
  resolution TEXT,
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disputes_org ON dropship_disputes(organization_id);
CREATE INDEX IF NOT EXISTS idx_disputes_supplier ON dropship_disputes(supplier_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON dropship_disputes(status)
  WHERE status NOT IN ('closed', 'resolved_partner', 'resolved_seller', 'resolved_compromise');
CREATE INDEX IF NOT EXISTS idx_disputes_return ON dropship_disputes(return_id) WHERE return_id IS NOT NULL;

GRANT ALL ON TABLE public.dropship_disputes TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dropship_disputes TO authenticated;
