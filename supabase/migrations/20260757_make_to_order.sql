-- ============================================================
-- Product OS — T1-B: Make-to-order (pedido real → reposição da produção)
--
-- Quando um produto de impressão 3D (product_dev.product_id setado) tem o
-- estoque físico (product_stock) abaixo do ponto de reposição, o sistema
-- SUGERE — ou, em modo automático, CRIA — uma ordem de produção. Fecha o loop
-- "vendi → produzi → repus" sem digitar. Reconciliação por cron (15 min) varre
-- o nosso próprio estoque (não é polling de marketplace). 100% aditivo.
-- ============================================================

-- (1) Config de reposição automática POR produto (no product_dev)
--     mto_enabled    — liga a vigilância de estoque deste produto
--     mto_mode       — 'suggest' (default, seguro: só sugere) | 'auto' (cria OP)
--     mto_reorder_point — dispara quando disponível <= este valor
--     mto_batch_qty  — quantas unidades produzir por disparo
ALTER TABLE product_dev
  ADD COLUMN IF NOT EXISTS mto_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mto_mode          TEXT    NOT NULL DEFAULT 'suggest',
  ADD COLUMN IF NOT EXISTS mto_reorder_point INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mto_batch_qty     INTEGER NOT NULL DEFAULT 0;

-- (2) Sugestões de reposição (fila revisável + trilha do que foi automático)
CREATE TABLE IF NOT EXISTS production_suggestion (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,
  product_id      UUID,                              -- SKU vinculado (snapshot)
  reason          TEXT,                              -- texto legível do gatilho
  available_at_trigger NUMERIC,                      -- disponível no momento
  reorder_point   INTEGER,
  suggested_qty   INTEGER NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'suggest',   -- modo no disparo
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | dismissed | auto_created | superseded
  source          TEXT NOT NULL DEFAULT 'reconcile', -- reconcile | manual
  production_order_id UUID REFERENCES production_order(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prodsug_org_status ON production_suggestion(organization_id, status, created_at DESC);
-- só UMA sugestão aberta (pendente) por produto → não empilha a cada ciclo do cron
CREATE UNIQUE INDEX IF NOT EXISTS ux_prodsug_open ON production_suggestion(product_dev_id) WHERE status = 'pending';

-- updated_at (reusa a função do Product OS)
DROP TRIGGER IF EXISTS trg_production_suggestion_updated ON production_suggestion;
CREATE TRIGGER trg_production_suggestion_updated BEFORE UPDATE ON production_suggestion
  FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at();

ALTER TABLE production_suggestion ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prodsug_select ON production_suggestion;
CREATE POLICY prodsug_select ON production_suggestion FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS prodsug_modify ON production_suggestion;
CREATE POLICY prodsug_modify ON production_suggestion FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

GRANT ALL ON TABLE public.production_suggestion TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.production_suggestion TO authenticated;
