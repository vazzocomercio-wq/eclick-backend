-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 4 Batch A — Ordem de Compra (OC)
-- ════════════════════════════════════════════════════════════════════════
-- IMPORTANTE: dropship_purchase_orders ≠ purchase_orders (importação).
--   - purchase_orders        → fluxo de importação (incoterm/container/BL)
--   - dropship_purchase_orders → fluxo dropship diário (1 OC por dia
--     por supplier por conta marketplace)
--
-- Workflow:
--   1. Cron 22h itera orgs → agrupa identifications elegíveis
--      (status='eligible_for_oc' OR 'shipped_confirmed') por
--      (supplier, marketplace, conta).
--   2. Cria 1 dropship_purchase_orders + N dropship_purchase_order_items
--      com snapshot de custo (current_table strategy).
--   3. Atualiza identifications.oc_id + dropship_status='in_oc_generated'.
--   4. Sprint 5 adiciona prévia/cutoff. Sprint 6 adiciona portal+envio.
--   5. Sprint 7 lança em contas a pagar.
-- ════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. Ordens de Compra dropship
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),

  -- Identificação
  oc_number TEXT NOT NULL UNIQUE,        -- ex: "DOC-2026-05-08-VAZZO-FORNEC_A-001"
  marketplace TEXT,
  marketplace_account_label TEXT,
  seller_id BIGINT,
  shopee_shop_id TEXT,
  amazon_seller_id TEXT,

  -- Período
  reference_date DATE NOT NULL,          -- Dia da venda/envio que gerou
  generation_date TIMESTAMPTZ NOT NULL,  -- Quando foi gerada
  due_date DATE NOT NULL,                -- Vencimento conforme prazo

  -- Valores
  items_count INTEGER NOT NULL DEFAULT 0,
  units_count INTEGER NOT NULL DEFAULT 0,
  gross_total NUMERIC NOT NULL DEFAULT 0,
  return_credits NUMERIC DEFAULT 0,
  cancellation_credits NUMERIC DEFAULT 0,
  warranty_credits NUMERIC DEFAULT 0,
  divergence_credits NUMERIC DEFAULT 0,
  other_credits NUMERIC DEFAULT 0,
  total_credits NUMERIC GENERATED ALWAYS AS (
    return_credits + cancellation_credits + warranty_credits +
    divergence_credits + other_credits
  ) STORED,
  net_total NUMERIC NOT NULL DEFAULT 0,

  -- Status (workflow completo desde draft até paid)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',                -- Prévia (durante o dia)
    'preview_locked',       -- Cutoff atingido, aguardando geração 22h
    'generating',           -- Sendo gerada (transient)
    'generated',            -- Oficialmente criada
    'sent',                 -- Enviada ao parceiro
    'viewed',               -- Parceiro visualizou
    'approved',             -- Parceiro aprovou
    'approved_with_notes',  -- Aprovou com ressalvas
    'rejected',             -- Rejeitou
    'in_payable',           -- Lançada em contas a pagar
    'paid',                 -- Pago
    'partially_paid',       -- Pago parcialmente
    'cancelled',            -- Cancelada
    'on_hold'               -- Suspensa (revisão)
  )),

  -- Aprovação parceiro (Sprint 6)
  sent_to_partner_at TIMESTAMPTZ,
  partner_viewed_at TIMESTAMPTZ,
  partner_approved_at TIMESTAMPTZ,
  partner_approval_notes TEXT,
  partner_rejection_reason TEXT,
  partner_approved_by_name TEXT,
  partner_approved_by_email TEXT,

  -- Aprovação interna
  internal_approved_at TIMESTAMPTZ,
  internal_approved_by UUID REFERENCES auth.users(id),

  -- Pagamento (Sprint 7)
  paid_at TIMESTAMPTZ,
  payment_proof_url TEXT,
  payment_method TEXT,
  payment_reference TEXT,

  -- Lançamento financeiro (Sprint 7)
  payable_id UUID,

  -- Documentos (Sprint 5)
  pdf_url TEXT,
  pdf_storage_path TEXT,
  excel_url TEXT,
  excel_storage_path TEXT,

  -- Metadados
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dropship_oc_org
  ON dropship_purchase_orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_dropship_oc_supplier
  ON dropship_purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_dropship_oc_status
  ON dropship_purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_dropship_oc_due_date
  ON dropship_purchase_orders(due_date)
  WHERE status IN ('approved', 'in_payable', 'partially_paid');
CREATE INDEX IF NOT EXISTS idx_dropship_oc_reference_date
  ON dropship_purchase_orders(reference_date DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Itens da OC
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oc_id UUID NOT NULL REFERENCES dropship_purchase_orders(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  identification_id UUID NOT NULL REFERENCES dropship_order_identifications(id),

  -- Snapshot dos dados do pedido
  order_id UUID REFERENCES orders(id),
  ml_pack_id TEXT,
  ml_order_id TEXT,
  ml_shipment_id TEXT,
  marketplace TEXT NOT NULL,
  product_id UUID REFERENCES products(id),
  supplier_product_id UUID REFERENCES supplier_products(id),
  partner_sku TEXT NOT NULL,
  master_sku TEXT,
  product_name TEXT NOT NULL,
  variation_label TEXT,

  -- Quantidades
  quantity INTEGER NOT NULL,

  -- Custo (snapshot da tabela vigente — current_table strategy)
  unit_cost NUMERIC NOT NULL,
  packaging_cost NUMERIC DEFAULT 0,
  handling_cost NUMERIC DEFAULT 0,
  unit_total_cost NUMERIC GENERATED ALWAYS AS (
    unit_cost + packaging_cost + handling_cost
  ) STORED,
  line_total NUMERIC GENERATED ALWAYS AS (
    (unit_cost + packaging_cost + handling_cost) * quantity
  ) STORED,

  -- Datas
  sale_date TIMESTAMPTZ NOT NULL,
  shipped_at TIMESTAMPTZ,

  -- Status do item dentro da OC (Sprints 8-9)
  status TEXT NOT NULL DEFAULT 'included' CHECK (status IN (
    'included',           -- No total da OC
    'pending_credit',     -- Aguardando crédito (devolução em curso)
    'credited',           -- Foi creditado (devolvido)
    'disputed',           -- Em disputa
    'excluded'            -- Removido manualmente
  )),

  notes TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oc_items_oc
  ON dropship_purchase_order_items(oc_id);
CREATE INDEX IF NOT EXISTS idx_oc_items_identification
  ON dropship_purchase_order_items(identification_id);
CREATE INDEX IF NOT EXISTS idx_oc_items_partner_sku
  ON dropship_purchase_order_items(partner_sku);

-- Idempotência: 1 identification só pode aparecer 1x em items
CREATE UNIQUE INDEX IF NOT EXISTS idx_oc_items_identification_unique
  ON dropship_purchase_order_items(identification_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3. GRANTs
-- ─────────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE public.dropship_purchase_orders TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dropship_purchase_orders TO authenticated;

GRANT ALL ON TABLE public.dropship_purchase_order_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dropship_purchase_order_items TO authenticated;
