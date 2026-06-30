-- ============================================================
-- Product OS — Gerador de SKU inteligível (taxonomia codificada)
--
-- SKU = MARCA + CATEGORIA + SUB + LINHA + CARACTERISTICA + "-" + COR
--       VZ    01          01    02      31               -   02   = VZ01010231-02
--
-- Cada dimensão é um valor codificado no catálogo (sku_taxonomy). Categoria→Sub→
-- Linha→Característica são HIERÁRQUICOS (o código é sequencial DENTRO do pai); a
-- Característica é o discriminador do modelo na linha (única por linha, repete em
-- linhas distintas). Cor é o eixo de variação: 1 modelo → N SKUs (base-cor).
-- Só vale p/ produtos PRODUZIDOS no Product OS. 100% aditivo.
-- ============================================================

-- (1) Catálogo de taxonomia (defaults+custom por org, inline-create)
CREATE TABLE IF NOT EXISTS sku_taxonomy (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,            -- marca | categoria | sub | linha | caracteristica | cor
  code            TEXT NOT NULL,            -- segmento do SKU (VZ, 01, 31…)
  label           TEXT NOT NULL,            -- nome legível (Vazzo, Decoração, moderna…)
  parent_id       UUID REFERENCES sku_taxonomy(id) ON DELETE CASCADE,  -- pai na hierarquia
  sort_order      INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- código único por (org, kind, pai); idem o label, p/ não duplicar valor
CREATE UNIQUE INDEX IF NOT EXISTS ux_skutax_code ON sku_taxonomy
  (organization_id, kind, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE UNIQUE INDEX IF NOT EXISTS ux_skutax_label ON sku_taxonomy
  (organization_id, kind, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(label));
CREATE INDEX IF NOT EXISTS idx_skutax_kind ON sku_taxonomy(organization_id, kind, parent_id, sort_order);

-- (2) Classificação do modelo no product_dev + base gerado
ALTER TABLE product_dev
  ADD COLUMN IF NOT EXISTS sku_marca_id          UUID REFERENCES sku_taxonomy(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sku_categoria_id      UUID REFERENCES sku_taxonomy(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sku_sub_id            UUID REFERENCES sku_taxonomy(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sku_linha_id          UUID REFERENCES sku_taxonomy(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sku_caracteristica_id UUID REFERENCES sku_taxonomy(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sku_base              TEXT;   -- VZ01010231 (sem a cor)

-- (3) Variantes de cor → 1 SKU por cor (base-cor)
CREATE TABLE IF NOT EXISTS product_dev_sku_variant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,
  cor_id          UUID NOT NULL REFERENCES sku_taxonomy(id) ON DELETE RESTRICT,
  sku             TEXT NOT NULL,            -- VZ01010231-02
  product_id      UUID,                     -- SKU publicado no catálogo (quando vira anúncio)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdsv_dev_cor ON product_dev_sku_variant(product_dev_id, cor_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdsv_sku ON product_dev_sku_variant(organization_id, sku);
CREATE INDEX IF NOT EXISTS idx_pdsv_dev ON product_dev_sku_variant(product_dev_id);

-- updated_at (reusa a função do Product OS)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sku_taxonomy','product_dev_sku_variant'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at()', t, t);
  END LOOP;
END $$;

-- RLS + GRANTs (padrão Product OS)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sku_taxonomy','product_dev_sku_variant'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', t, t);
    EXECUTE format('CREATE POLICY %I_select ON %I FOR SELECT TO authenticated USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_modify ON %I', t, t);
    EXECUTE format('CREATE POLICY %I_modify ON %I FOR ALL TO authenticated USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())) WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))', t, t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
  END LOOP;
END $$;
