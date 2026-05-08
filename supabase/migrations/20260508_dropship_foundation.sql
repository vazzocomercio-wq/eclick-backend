-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 1 Batch A — Fundação
-- ════════════════════════════════════════════════════════════════════════
-- Cria a base do módulo Dropship reusando `suppliers` existente:
--
--   1. ALTER `supplier_products` — adiciona 6 campos dropship-específicos
--      (estoque do fornecedor, master_sku, packaging/handling cost, etc.)
--   2. CREATE `supplier_dropship_profiles` — perfil dropship 1:1 com
--      um supplier (cutoff time, integration_type, oc_generation_time,
--      cost_strategy, return_credit_strategy, score, etc.)
--   3. CREATE `seller_account_suppliers` — mapeia conta de marketplace
--      (ML/Shopee/Amazon) ao supplier que despacha por aquela conta.
--
-- Decisão arquitetural (Opção C — ver docs/dropship-center-design.md):
--   - `suppliers` é cadastro genérico (importação E dropship).
--   - `supplier_products` é catálogo do fornecedor — estendido aqui.
--   - `purchase_orders` (existente) NÃO se confunde com OC dropship —
--     aquela é fluxo de importação (incoterm, container_number, BL).
--     OC dropship vira `dropship_purchase_orders` (Sprint 4).
--
-- UI usa "Parceiro Dropship" (PT-BR amigável); backend usa `supplier_id`
-- na tabela e expõe rotas `/dropship/partners` (clareza de domínio).
-- ════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. Estender supplier_products com campos dropship
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_stock INTEGER DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_reserved INTEGER DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_available INTEGER
  GENERATED ALWAYS AS (partner_stock - partner_reserved) STORED;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS master_sku TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_packaging_cost NUMERIC DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_handling_cost NUMERIC DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS last_stock_change_at TIMESTAMPTZ;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS last_cost_change_at TIMESTAMPTZ;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS dropship_status TEXT DEFAULT 'active'
  CHECK (dropship_status IN ('active', 'paused', 'unavailable', 'discontinued', 'pending_validation'));

CREATE INDEX IF NOT EXISTS idx_supplier_products_master_sku ON supplier_products(master_sku);
CREATE INDEX IF NOT EXISTS idx_supplier_products_dropship_status ON supplier_products(dropship_status);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Perfil dropship 1:1 com supplier
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_dropship_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  -- Operação dropship
  notification_email TEXT NOT NULL,
  notification_whatsapp TEXT,
  operations_contact TEXT,
  operations_phone TEXT,
  warehouse_address JSONB,

  -- Tipo de integração
  integration_type TEXT NOT NULL DEFAULT 'manual' CHECK (integration_type IN (
    'manual', 'spreadsheet', 'api', 'csv_email', 'sftp',
    'erp_bling', 'erp_tiny', 'erp_omie'
  )),
  integration_config JSONB DEFAULT '{}',

  -- Janela operacional do parceiro
  cutoff_time TIME DEFAULT '14:00',
  ship_lead_days INTEGER DEFAULT 1,
  weekend_processing BOOLEAN DEFAULT false,
  holidays_processing BOOLEAN DEFAULT false,

  -- Janela de OC (gerada pelo SaaS)
  oc_generation_time TIME DEFAULT '22:00',
  oc_preview_open_time TIME DEFAULT '12:00',
  oc_review_cutoff_time TIME DEFAULT '21:00',

  -- Estratégia comercial (campos do contrato — versionamento na v2)
  cost_strategy TEXT NOT NULL DEFAULT 'current_table' CHECK (cost_strategy IN (
    'current_table', 'at_sale_date', 'at_ship_date', 'fixed_per_period', 'per_campaign'
  )),
  return_credit_strategy TEXT DEFAULT 'next_oc' CHECK (return_credit_strategy IN (
    'same_oc', 'next_oc', 'separate_invoice'
  )),
  return_responsibility JSONB DEFAULT '{}',
  cost_divergence_tolerance_pct NUMERIC DEFAULT 5,
  stock_divergence_tolerance_units INTEGER DEFAULT 2,
  marketplaces_supported JSONB DEFAULT '[]',

  -- Status dropship
  dropship_status TEXT NOT NULL DEFAULT 'active' CHECK (dropship_status IN (
    'active', 'paused', 'inactive', 'pending_setup'
  )),
  paused_reason TEXT,

  -- Métricas calculadas (atualizadas via cron)
  active_dropship_skus INTEGER DEFAULT 0,
  orders_30d INTEGER DEFAULT 0,
  revenue_30d NUMERIC DEFAULT 0,
  cmv_30d NUMERIC DEFAULT 0,
  pending_payable NUMERIC DEFAULT 0,

  -- Score (preenchido pela Camada D4)
  partner_score INTEGER CHECK (partner_score >= 0 AND partner_score <= 100),
  score_breakdown JSONB DEFAULT '{}',

  -- Documentos
  contract_pdf_url TEXT,
  contract_pdf_storage_path TEXT,

  -- Metadados
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_dropship_profiles_supplier
  ON supplier_dropship_profiles(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_dropship_profiles_org
  ON supplier_dropship_profiles(organization_id);
CREATE INDEX IF NOT EXISTS idx_supplier_dropship_profiles_status
  ON supplier_dropship_profiles(dropship_status);

-- ─────────────────────────────────────────────────────────────────────
-- 3. Mapeamento conta marketplace ↔ supplier
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS seller_account_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  marketplace TEXT NOT NULL CHECK (marketplace IN (
    'mercado_livre', 'shopee', 'amazon', 'magalu', 'others'
  )),
  seller_id BIGINT,         -- Para Mercado Livre
  shopee_shop_id TEXT,      -- Para Shopee
  amazon_seller_id TEXT,    -- Para Amazon
  account_label TEXT,       -- Nome amigável (ex: "Vazzo ML", "EsLar Shopee")

  is_default BOOLEAN DEFAULT true,
  active_since DATE NOT NULL DEFAULT CURRENT_DATE,
  active_until DATE,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_account_suppliers_org
  ON seller_account_suppliers(organization_id);
CREATE INDEX IF NOT EXISTS idx_seller_account_suppliers_supplier
  ON seller_account_suppliers(supplier_id);
-- Índice único: 1 conta de marketplace só pode ter 1 supplier default ativo por vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_account_suppliers_default
  ON seller_account_suppliers(
    organization_id, marketplace,
    COALESCE(seller_id::text, ''),
    COALESCE(shopee_shop_id, ''),
    COALESCE(amazon_seller_id, '')
  )
  WHERE is_default = true AND active_until IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 4. GRANTs (gotcha §11.J skill vazzo-direct: tables criadas via
--    _admin_exec_sql RPC não recebem default privileges do Supabase)
-- ─────────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE public.supplier_dropship_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_dropship_profiles TO authenticated;

GRANT ALL ON TABLE public.seller_account_suppliers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.seller_account_suppliers TO authenticated;
