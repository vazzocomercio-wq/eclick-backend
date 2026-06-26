-- ============================================================
-- Product OS — Peças & Montagem (Fases 1+2 do épico "partes separadas")
--
-- Um PRODUTO passa a poder ser composto por várias PEÇAS imprimíveis
-- (ex: luminária = base + cúpula + 3 conectores). Cada peça tem seus
-- próprios arquivos/versões, peso e tempo, pode ser produzida sozinha
-- (OP de uma peça) e tem ESTOQUE de peças prontas (semi-acabado). A
-- MONTAGEM consome peças prontas → vira produto pronto.
--
-- 100% aditivo e retrocompatível: produto de 1 peça só (os atuais)
-- continua funcionando com part_id = NULL em tudo.
--   3 tabelas novas + 2 colunas novas. Reusa set_product_os_updated_at().
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. product_dev_part — uma PEÇA imprimível do produto
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_dev_part (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,

  name            TEXT NOT NULL,                 -- "Base", "Cúpula", "Conector"
  qty_per_product NUMERIC NOT NULL DEFAULT 1 CHECK (qty_per_product > 0),  -- quantas por produto montado
  is_optional     BOOLEAN NOT NULL DEFAULT false,

  -- estoque de peças PRONTAS (semi-acabado) — alimentado pela OP da peça
  stock_qty       NUMERIC NOT NULL DEFAULT 0,
  reserved_qty    NUMERIC NOT NULL DEFAULT 0,

  sort_order      INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pdpart_org ON product_dev_part(organization_id);
CREATE INDEX IF NOT EXISTS idx_pdpart_dev ON product_dev_part(product_dev_id, sort_order);

-- ─────────────────────────────────────────────────────────────────
-- 2. product_dev_part_movement — ledger do estoque de peças prontas
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_dev_part_movement (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  part_id         UUID NOT NULL REFERENCES product_dev_part(id) ON DELETE CASCADE,
  movement_type   TEXT NOT NULL CHECK (movement_type IN ('produced','reserve','release','consume','adjust')),
  quantity        NUMERIC NOT NULL,
  balance_after   NUMERIC,
  reference_type  TEXT,   -- 'production_order' | 'assembly_order' | 'manual'
  reference_id    TEXT,
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pdpmov_org  ON product_dev_part_movement(organization_id);
CREATE INDEX IF NOT EXISTS idx_pdpmov_part ON product_dev_part_movement(part_id);
CREATE INDEX IF NOT EXISTS idx_pdpmov_ref  ON product_dev_part_movement(reference_type, reference_id);
-- idempotência: 1 movimento por (peça, ref, tipo)
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdpmov_ref ON product_dev_part_movement(part_id, reference_type, reference_id, movement_type)
  WHERE reference_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 3. assembly_order — ordem de MONTAGEM (consome peças → produto pronto)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assembly_order (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,
  order_number    INTEGER NOT NULL DEFAULT 0,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),   -- nº de produtos a montar
  status TEXT NOT NULL DEFAULT 'fila' CHECK (status IN ('fila','montando','concluido','cancelado')),
  stock_movement_done BOOLEAN NOT NULL DEFAULT false,       -- crédito de produto acabado já feito?
  notes        TEXT,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asm_org    ON assembly_order(organization_id);
CREATE INDEX IF NOT EXISTS idx_asm_status ON assembly_order(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_asm_dev    ON assembly_order(product_dev_id);

-- ─────────────────────────────────────────────────────────────────
-- 4. product_dev_version.part_id — versão/arquivo pode ser de uma PEÇA
--    NULL = arquivo do produto inteiro (retrocompat). Ajusta o UNIQUE
--    p/ numeração de versão independente por peça.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE product_dev_version ADD COLUMN IF NOT EXISTS part_id UUID REFERENCES product_dev_part(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_pdv_part ON product_dev_version(part_id) WHERE part_id IS NOT NULL;

DO $$
DECLARE cname TEXT;
BEGIN
  -- remove o UNIQUE antigo (product_dev_id, version_number), qualquer que seja o nome
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'product_dev_version'::regclass AND contype = 'u'
     AND pg_get_constraintdef(oid) ILIKE '%(product_dev_id, version_number)%' LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE product_dev_version DROP CONSTRAINT %I', cname);
  END IF;
END $$;
-- versão do produto inteiro: única por (produto, número)
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdv_whole ON product_dev_version(product_dev_id, version_number) WHERE part_id IS NULL;
-- versão de peça: única por (peça, número)
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdv_part  ON product_dev_version(part_id, version_number) WHERE part_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 5. production_order.part_id — OP pode ser de uma PEÇA só
--    NULL = produto inteiro (retrocompat). Set = imprime só a peça.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE production_order ADD COLUMN IF NOT EXISTS part_id UUID REFERENCES product_dev_part(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_po_part ON production_order(part_id) WHERE part_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- updated_at triggers (reusa a função das fases anteriores)
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_dev_part','assembly_order'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at()', t, t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- RLS + GRANTs (forma inline das fases anteriores)
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_dev_part','product_dev_part_movement','assembly_order'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %s_select ON %I', t, t);
    EXECUTE format('CREATE POLICY %s_select ON %I FOR SELECT TO authenticated USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %s_modify ON %I', t, t);
    EXECUTE format('CREATE POLICY %s_modify ON %I FOR ALL TO authenticated USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())) WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))', t, t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
  END LOOP;
END $$;
