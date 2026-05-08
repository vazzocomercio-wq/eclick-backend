-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 2 Batch A — Sync de catálogo
-- ════════════════════════════════════════════════════════════════════════
-- Cria tabelas de suporte ao sync de catálogo do parceiro:
--
--   1. CREATE `supplier_cost_history` — histórico genérico de custos
--      por supplier_product. Serve auditoria histórica (não é fonte
--      pro cálculo de OC: a OC sempre usa supplier_products.unit_cost
--      vigente quando cost_strategy='current_table').
--
--   2. CREATE `dropship_sync_logs` — log de cada sync (manual, planilha,
--      api_pull, etc.) com counters de produtos processados/criados/
--      atualizados, mudanças significativas de custo (>5% por padrão),
--      SKUs out-of-stock detectados, e status de sucesso/falha.
--
-- Workflow do sync:
--   1. Frontend posta /dropship/sync (file ou api trigger).
--   2. Service cria dropship_sync_logs row com status='running'.
--   3. Para cada linha do source: upsert supplier_products.
--   4. Se cost mudou: insert supplier_cost_history (close anterior).
--   5. Atualiza counters no log → status='completed' (ou 'failed').
-- ════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. Histórico de custos por supplier_product (auditoria)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_cost_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_product_id UUID NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,

  -- Custos no período
  cost_value NUMERIC NOT NULL,
  cost_packaging NUMERIC DEFAULT 0,
  cost_handling NUMERIC DEFAULT 0,
  cost_total NUMERIC NOT NULL,

  -- Vigência (NULL em effective_until = vigente)
  effective_from TIMESTAMPTZ NOT NULL,
  effective_until TIMESTAMPTZ,

  -- Origem da mudança
  change_reason TEXT,
  change_source TEXT CHECK (change_source IN (
    'manual', 'spreadsheet_import', 'api_sync', 'partner_notification'
  )),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_cost_history_product
  ON supplier_cost_history(supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_supplier_cost_history_effective
  ON supplier_cost_history(effective_from, effective_until);
CREATE INDEX IF NOT EXISTS idx_supplier_cost_history_current
  ON supplier_cost_history(supplier_product_id) WHERE effective_until IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Logs de sync com fornecedores dropship
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,

  -- Tipo de sync
  sync_type TEXT NOT NULL CHECK (sync_type IN (
    'catalog_full',        -- Catálogo inteiro
    'catalog_incremental', -- Só alterações
    'stock',               -- Só estoque
    'cost',                -- Só custo
    'spreadsheet_import',  -- Upload XLSX/CSV
    'api_pull',            -- Pull da API do parceiro
    'manual'               -- Edição manual
  )),
  source TEXT,                -- 'spreadsheet', 'api', 'manual', 'sftp', 'csv_email'
  source_file_url TEXT,       -- Storage URL do arquivo (se aplicável)
  source_file_name TEXT,

  -- Resultados (counters)
  products_processed INTEGER DEFAULT 0,
  products_created INTEGER DEFAULT 0,
  products_updated INTEGER DEFAULT 0,
  products_failed INTEGER DEFAULT 0,
  cost_changes_count INTEGER DEFAULT 0,
  stock_changes_count INTEGER DEFAULT 0,

  -- Mudanças significativas (pra alertar admin)
  significant_cost_changes JSONB DEFAULT '[]',
  -- [{ "supplier_sku": "ABC", "old": 50.00, "new": 55.00, "pct_change": 10 }]
  significant_stock_changes JSONB DEFAULT '[]',
  out_of_stock_skus TEXT[] DEFAULT '{}',

  -- Validation errors (linhas que falharam)
  validation_errors JSONB DEFAULT '[]',
  -- [{ "row": 5, "supplier_sku": "XYZ", "error": "cost inválido" }]

  -- Status
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'failed', 'partial'
  )),
  error_message TEXT,
  duration_seconds INTEGER,

  -- Quem disparou
  triggered_by UUID REFERENCES auth.users(id),

  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dropship_sync_org
  ON dropship_sync_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_dropship_sync_supplier
  ON dropship_sync_logs(supplier_id);
CREATE INDEX IF NOT EXISTS idx_dropship_sync_status
  ON dropship_sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_dropship_sync_started
  ON dropship_sync_logs(started_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 3. GRANTs (gotcha §11.J skill vazzo-direct)
-- ─────────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE public.supplier_cost_history TO service_role;
GRANT SELECT, INSERT ON TABLE public.supplier_cost_history TO authenticated;

GRANT ALL ON TABLE public.dropship_sync_logs TO service_role;
GRANT SELECT, INSERT ON TABLE public.dropship_sync_logs TO authenticated;
