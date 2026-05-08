-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 3 Batch A — Identificação de pedidos
-- ════════════════════════════════════════════════════════════════════════
-- Cria tabelas que conectam vendas de marketplace ao fluxo dropship:
--
--   1. CREATE `dropship_order_identifications` — registra cada pedido
--      identificado como dropship, com snapshot de custo no momento
--      da venda + status do ciclo (identified → shipped → eligible_for_oc
--      → in_oc → paid). Idempotente por order_id.
--
--   2. CREATE `dropship_summary` — agregado por org pra dashboard
--      executivo (atualizado via cron ou trigger).
--
-- Workflow de identificação (Sprint 3 Batch B):
--   1. Cron lê orders novos do org dos últimos 7 dias.
--   2. Pra cada order: produto.supply_type === 'dropship'? sim →
--   3. Resolve supplier via seller_account_suppliers (account → supplier).
--   4. Match supplier_products (supplier_id, product_id).
--   5. Cria dropship_order_identifications com snapshot de custo.
--   6. Updates conforme marketplace muda status (shipped, delivered, etc).
-- ════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. Identificação de pedidos como dropship
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_order_identifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),

  -- Referência ao pedido original
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  ml_pack_id TEXT,
  ml_order_id TEXT,
  ml_shipment_id TEXT,
  shopee_order_id TEXT,
  amazon_order_id TEXT,

  -- Vínculo dropship (resolvido via seller_account_suppliers)
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  supplier_product_id UUID REFERENCES supplier_products(id),
  product_id UUID REFERENCES products(id),

  -- Snapshot do momento da identificação (auditoria)
  ml_item_id TEXT,
  partner_sku TEXT NOT NULL,        -- = supplier_products.supplier_sku
  master_sku TEXT,
  quantity INTEGER NOT NULL,

  -- Custos (snapshot pra auditoria; OC usa current_table no Sprint 4)
  cost_at_sale NUMERIC,             -- custo do supplier_products no momento
  sale_price NUMERIC,               -- preço de venda
  estimated_cost_at_oc NUMERIC,     -- custo previsto na OC
  estimated_margin NUMERIC,         -- margem estimada (sale - cost)

  -- Status do pedido (espelha marketplace)
  marketplace_status TEXT,
  shipping_status TEXT,
  payment_status TEXT,

  -- Status no fluxo dropship (controlado pelo nosso sistema)
  dropship_status TEXT NOT NULL DEFAULT 'identified' CHECK (dropship_status IN (
    'identified',         -- Detectado como dropship
    'awaiting_shipment',  -- Aguardando envio
    'shipped',            -- Marketplace marcou enviado
    'shipped_confirmed',  -- Parceiro confirmou expedição
    'eligible_for_oc',    -- Elegível pra OC do dia
    'in_oc_draft',        -- Está na prévia da OC
    'in_oc_generated',    -- Foi pra OC gerada
    'in_oc_approved',     -- OC aprovada pelo parceiro
    'in_payable',         -- Lançado em contas a pagar
    'paid',               -- Pago ao parceiro
    'cancelled',          -- Cancelado antes de OC
    'returned',           -- Retornado/devolvido
    'on_hold',            -- Suspenso (divergência, SAC)
    'excluded'            -- Excluído manualmente
  )),
  hold_reason TEXT,

  -- Datas do ciclo
  identified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at TIMESTAMPTZ,
  shipment_confirmed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  oc_id UUID,                      -- preenchido quando entra em OC (Sprint 4)

  -- Metadados
  raw_marketplace_data JSONB,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dropship_orders_org
  ON dropship_order_identifications(organization_id);
CREATE INDEX IF NOT EXISTS idx_dropship_orders_supplier
  ON dropship_order_identifications(supplier_id);
CREATE INDEX IF NOT EXISTS idx_dropship_orders_order
  ON dropship_order_identifications(order_id);
CREATE INDEX IF NOT EXISTS idx_dropship_orders_status
  ON dropship_order_identifications(dropship_status);
CREATE INDEX IF NOT EXISTS idx_dropship_orders_eligible
  ON dropship_order_identifications(dropship_status)
  WHERE dropship_status = 'eligible_for_oc';
CREATE INDEX IF NOT EXISTS idx_dropship_orders_shipped
  ON dropship_order_identifications(shipped_at DESC);
CREATE INDEX IF NOT EXISTS idx_dropship_orders_oc
  ON dropship_order_identifications(oc_id) WHERE oc_id IS NOT NULL;

-- Idempotência: 1 order_id só pode ter 1 identification dropship
CREATE UNIQUE INDEX IF NOT EXISTS idx_dropship_orders_order_unique
  ON dropship_order_identifications(order_id) WHERE order_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Resumo agregado por org (dashboard)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id),

  -- Totais gerais
  active_partners_count INTEGER DEFAULT 0,
  active_dropship_skus INTEGER DEFAULT 0,
  active_dropship_listings INTEGER DEFAULT 0,

  -- Operação do dia
  shipped_today INTEGER DEFAULT 0,
  shipped_today_value NUMERIC DEFAULT 0,
  pending_oc_today_count INTEGER DEFAULT 0,
  pending_oc_today_value NUMERIC DEFAULT 0,

  -- Estoque
  out_of_stock_skus_count INTEGER DEFAULT 0,
  low_stock_skus_count INTEGER DEFAULT 0,

  -- Financeiro (preenchido a partir do Sprint 4)
  pending_payable_value NUMERIC DEFAULT 0,
  next_7d_payable_value NUMERIC DEFAULT 0,
  next_30d_payable_value NUMERIC DEFAULT 0,

  -- Pendências (preenchido a partir do Sprint 8/9)
  open_returns_count INTEGER DEFAULT 0,
  open_returns_value NUMERIC DEFAULT 0,
  open_divergences_count INTEGER DEFAULT 0,
  open_divergences_value NUMERIC DEFAULT 0,
  pending_partner_credits NUMERIC DEFAULT 0,

  -- Performance (preenchido a partir do Sprint 11)
  avg_partner_score NUMERIC,
  partners_at_risk_count INTEGER DEFAULT 0,

  last_sync_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dropship_summary_updated
  ON dropship_summary(updated_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 3. GRANTs
-- ─────────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE public.dropship_order_identifications TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dropship_order_identifications TO authenticated;

GRANT ALL ON TABLE public.dropship_summary TO service_role;
GRANT SELECT ON TABLE public.dropship_summary TO authenticated;
