-- ============================================================
-- Product OS — Sistema de códigos (rastreio perfeito)
--
-- Hierarquia de identificação:
--   PRODUTO  product_dev.code        ex: CV-COASTER   (base, = SKU quando publicado)
--    └ PEÇA  product_dev_part.code   ex: CV-COASTER-01 (sub-SKU sequencial)
--   OP       production_order.order_number → exibida "OP-0005" (já sequencial)
--    └ UNIDADE production_unit.serial ex: OP0005-CV-COASTER-01-001 (lote=OP + serial único)
--
-- 100% aditivo. Códigos são gerados no backend; unidades nascem ao criar a OP.
-- ============================================================

-- código interno do produto (base dos sub-SKUs); pode coincidir com o SKU de venda
ALTER TABLE product_dev      ADD COLUMN IF NOT EXISTS code TEXT;
-- sub-SKU da peça (pertence ao código do produto)
ALTER TABLE product_dev_part ADD COLUMN IF NOT EXISTS code TEXT;

-- código único por org (não obriga, mas evita duplicar quando setado)
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_dev_code      ON product_dev(organization_id, code)      WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_dev_part_code ON product_dev_part(organization_id, code) WHERE code IS NOT NULL;

-- unidades físicas produzidas: 1 linha por unidade da OP (lote = OP, serial único)
CREATE TABLE IF NOT EXISTS production_unit (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  production_order_id  UUID NOT NULL REFERENCES production_order(id) ON DELETE CASCADE,
  product_dev_id       UUID,
  part_id              UUID,
  serial   TEXT NOT NULL,                          -- ex: OP0005-CV-COASTER-01-001
  seq      INTEGER NOT NULL,                        -- 1..N dentro da OP
  status   TEXT NOT NULL DEFAULT 'planejada',       -- planejada | produzida | descartada
  notes    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pu_org     ON production_unit(organization_id);
CREATE INDEX IF NOT EXISTS idx_pu_order   ON production_unit(production_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pu_serial ON production_unit(organization_id, serial);

DROP TRIGGER IF EXISTS trg_pu_updated ON production_unit;
CREATE TRIGGER trg_pu_updated BEFORE UPDATE ON production_unit
  FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at();

ALTER TABLE production_unit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pu_select ON production_unit;
CREATE POLICY pu_select ON production_unit FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS pu_modify ON production_unit;
CREATE POLICY pu_modify ON production_unit FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

GRANT ALL ON TABLE public.production_unit TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.production_unit TO authenticated;
