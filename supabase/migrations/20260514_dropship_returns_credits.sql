-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 8+9 — Devoluções + Régua de Crédito
-- ════════════════════════════════════════════════════════════════════════
-- Cria 2 tabelas que modelam o ciclo de devolução end-to-end:
--
--   1. CREATE `dropship_returns` — registra cada devolução/cancelamento
--      com tipo (11 categorias: cancellation, return_buyer_regret,
--      return_defective, etc.), responsabilidade (partner/seller/shared/
--      buyer/undefined), origem (webhook, sync, sac, manual, partner_request)
--      e estratégia de crédito aplicada (4 cenários).
--
--   2. CREATE `dropship_partner_credits` — saldo de créditos do parceiro
--      pra abater na próxima OC. remaining_amount GENERATED.
--
-- Régua de crédito (Sprint 9):
--   • same_oc_unpaid: OC ainda em draft/preview_locked → marca item
--     excluded direto, recalcula totais
--   • same_oc_approved_unpaid: OC sent/viewed/approved mas não paga →
--     marca item credited, ajusta net_total dentro da OC
--   • next_oc_credit: OC já paga → cria row em dropship_partner_credits
--     status='pending', aplicado na próxima OC do parceiro
--   • pending_dispute: em disputa → status='disputed', sem crédito
--     até resolução
--
-- Webhooks ML/Shopee deixados pra Sprint 8.5/v2 (precisa registrar
-- no ML Application + endpoint público com HMAC). Pra v1, criação
-- manual via UI.
-- ════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. Devoluções e cancelamentos
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),

  -- Pedido original
  identification_id UUID REFERENCES dropship_order_identifications(id),
  order_id UUID REFERENCES orders(id),
  ml_pack_id TEXT,
  ml_order_id TEXT,
  ml_shipment_id TEXT,
  shopee_order_id TEXT,
  marketplace TEXT NOT NULL,

  -- OC original (se já foi)
  original_oc_id UUID REFERENCES dropship_purchase_orders(id),
  original_oc_item_id UUID REFERENCES dropship_purchase_order_items(id),

  -- Tipo
  return_type TEXT NOT NULL CHECK (return_type IN (
    'cancellation',           -- Cancelamento antes envio
    'return_buyer_regret',    -- Arrependimento (7 dias)
    'return_defective',       -- Produto com defeito
    'return_wrong_item',      -- Item errado enviado
    'return_damaged',         -- Avariado no transporte
    'return_not_delivered',   -- Não recebido
    'return_incomplete',      -- Item incompleto
    'warranty_claim',         -- Garantia
    'reclamation_refund',     -- Reclamação com reembolso
    'chargeback',             -- Chargeback
    'partner_negotiated'      -- Desconto negociado
  )),

  -- Origem
  source TEXT NOT NULL CHECK (source IN (
    'marketplace_webhook',
    'marketplace_sync',
    'sac_module',
    'manual',
    'partner_request'
  )),
  external_id TEXT,                    -- ID da reclamação no marketplace

  -- Valores
  return_amount NUMERIC NOT NULL CHECK (return_amount >= 0),
  return_quantity INTEGER NOT NULL CHECK (return_quantity > 0),

  -- Responsabilidade
  responsibility TEXT CHECK (responsibility IN (
    'partner', 'seller', 'shared', 'buyer', 'undefined'
  )),
  responsibility_split JSONB,
  -- { "partner_pct": 50, "seller_pct": 50 } se shared

  -- Status
  status TEXT NOT NULL DEFAULT 'opened' CHECK (status IN (
    'opened',                 -- Aberto, em análise
    'in_transit_back',        -- Produto voltando
    'received',               -- Produto recebido
    'analyzed',               -- Analisado (defeito real, etc)
    'approved',               -- Crédito aprovado
    'credit_pending',         -- Aguardando aplicação em OC
    'credit_applied',         -- Crédito aplicado
    'disputed',               -- Em disputa
    'rejected',               -- Rejeitado (responsabilidade não é parceiro)
    'closed'                  -- Encerrado
  )),

  -- Crédito (preenchido quando aplicado)
  credit_amount NUMERIC,
  credit_applied_oc_id UUID REFERENCES dropship_purchase_orders(id),
  credit_applied_at TIMESTAMPTZ,
  credit_strategy TEXT CHECK (credit_strategy IN (
    'same_oc_unpaid',
    'same_oc_approved_unpaid',
    'next_oc_credit',
    'pending_dispute'
  )),

  -- Marketplace state
  marketplace_return_status TEXT,
  marketplace_refund_amount NUMERIC,
  marketplace_refunded_at TIMESTAMPTZ,

  -- Documentos
  evidence_urls TEXT[] DEFAULT '{}',
  evidence_storage_paths TEXT[] DEFAULT '{}',

  -- Notas
  buyer_complaint TEXT,
  internal_notes TEXT,
  partner_response TEXT,
  resolution_notes TEXT,

  -- Datas
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  marketplace_opened_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_returns_org ON dropship_returns(organization_id);
CREATE INDEX IF NOT EXISTS idx_returns_supplier ON dropship_returns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_returns_status ON dropship_returns(status);
CREATE INDEX IF NOT EXISTS idx_returns_pending_credit ON dropship_returns(status, supplier_id)
  WHERE status IN ('approved', 'credit_pending');
-- Idempotência por marketplace+external_id (evita reprocessamento webhook)
CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_external
  ON dropship_returns(marketplace, external_id) WHERE external_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Créditos do parceiro (saldo a abater na próxima OC)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_partner_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),

  -- Origem
  return_id UUID REFERENCES dropship_returns(id),
  manual_adjustment BOOLEAN DEFAULT false,
  source_oc_id UUID REFERENCES dropship_purchase_orders(id),

  -- Valor
  credit_amount NUMERIC NOT NULL CHECK (credit_amount > 0),
  credit_type TEXT NOT NULL CHECK (credit_type IN (
    'return',
    'cancellation',
    'warranty',
    'divergence',
    'manual_adjustment',
    'negotiated_discount',
    'previous_payment'
  )),

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'applied',
    'partially_applied',
    'cancelled',
    'expired'
  )),

  -- Aplicação
  applied_to_oc_id UUID REFERENCES dropship_purchase_orders(id),
  applied_amount NUMERIC DEFAULT 0,
  remaining_amount NUMERIC GENERATED ALWAYS AS (
    credit_amount - COALESCE(applied_amount, 0)
  ) STORED,
  applied_at TIMESTAMPTZ,

  -- Datas
  expires_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credits_supplier ON dropship_partner_credits(supplier_id);
CREATE INDEX IF NOT EXISTS idx_credits_status ON dropship_partner_credits(status);
CREATE INDEX IF NOT EXISTS idx_credits_pending
  ON dropship_partner_credits(supplier_id, status) WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────────
-- 3. GRANTs
-- ─────────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE public.dropship_returns TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dropship_returns TO authenticated;

GRANT ALL ON TABLE public.dropship_partner_credits TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dropship_partner_credits TO authenticated;
