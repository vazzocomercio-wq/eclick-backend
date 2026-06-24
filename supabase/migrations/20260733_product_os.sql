-- ============================================================
-- Product OS — Fase 1
-- Central de criação de produtos físicos: ideia → briefing IA →
-- versões CAD/protótipo → custo de fabricação → (Fase 3) anúncio.
--
-- 100% aditivo: 3 tabelas novas, nenhuma tabela existente é alterada.
-- Multi-tenant por organization_id + RLS. GRANTs explícitos (tabelas
-- criadas via _admin_exec_sql não herdam os grants default do Supabase).
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. product_dev — a ficha do produto ANTES de virar SKU (o "pré-produto")
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_dev (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  category    TEXT,
  description TEXT,

  -- ciclo de vida — move o card no kanban
  status TEXT NOT NULL DEFAULT 'ideia' CHECK (status IN (
    'ideia','briefing','modelagem','prototipo',
    'aprovado','publicado','monitorando','arquivado'
  )),

  -- perfil de produção: define quais campos 3D-específicos aparecem
  production_profile TEXT NOT NULL DEFAULT 'impressao_3d' CHECK (production_profile IN (
    'impressao_3d','marca_propria','generico'
  )),

  -- [{ url, source_url, notes }]
  reference_images JSONB NOT NULL DEFAULT '[]'::jsonb,
  inspiration_url  TEXT,

  -- briefing técnico gerado pela IA (estruturado p/ alimentar o CAD)
  briefing      JSONB,
  briefing_text TEXT,   -- versão legível pra colar no Claude Code / designer

  -- ['mercado_livre','shopee','tiktok','loja']
  target_marketplaces TEXT[] NOT NULL DEFAULT '{}',
  target_price        NUMERIC,
  estimated_cost      NUMERIC,  -- cache do custo de fabricação da versão aprovada

  -- vínculos preenchidos na Fase 3 (handoff p/ venda + Active)
  product_id     UUID REFERENCES products(id) ON DELETE SET NULL,
  active_deal_id TEXT,

  position   INTEGER NOT NULL DEFAULT 0,  -- ordem dentro da coluna do kanban
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_dev_org    ON product_dev(organization_id);
CREATE INDEX IF NOT EXISTS idx_product_dev_status ON product_dev(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_product_dev_prod   ON product_dev(product_id) WHERE product_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 2. product_dev_version — cada versão do arquivo 3D / protótipo
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_dev_version (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,

  version_number INTEGER NOT NULL,
  changelog      TEXT,

  file_url  TEXT,
  file_type TEXT CHECK (file_type IS NULL OR file_type IN (
    'stl','3mf','step','obj','fusion','other'
  )),

  -- métricas de fabricação (vêm do slicer Bambu ou do motor 3D)
  material           TEXT,      -- PLA, PETG, ABS
  weight_g           NUMERIC,   -- peso em gramas
  print_time_minutes INTEGER,
  volume_cm3         NUMERIC,

  prototype_photo_urls JSONB NOT NULL DEFAULT '[]'::jsonb,

  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN (
    'rascunho','impressao','aprovado','reprovado'
  )),
  approved BOOLEAN NOT NULL DEFAULT false,
  notes    TEXT,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (product_dev_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_pdv_org  ON product_dev_version(organization_id);
CREATE INDEX IF NOT EXISTS idx_pdv_dev  ON product_dev_version(product_dev_id);

-- ─────────────────────────────────────────────────────────────────
-- 3. production_settings — constantes de fabricação POR ORG (1 linha/org)
--    É o que torna o cálculo de custo genérico: cada cliente preenche
--    os valores dele; o motor é o mesmo.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,

  -- { "PLA": 90, "PETG": 110, "ABS": 100 } em R$/kg
  filament_cost_per_kg JSONB   NOT NULL DEFAULT '{}'::jsonb,
  energy_cost_per_hour NUMERIC NOT NULL DEFAULT 0,    -- R$/hora de impressão
  labor_cost_per_hour  NUMERIC NOT NULL DEFAULT 0,    -- R$/hora de mão de obra
  packaging_cost       NUMERIC NOT NULL DEFAULT 0,    -- R$/unidade (embalagem+etiqueta)
  default_waste_pct    NUMERIC NOT NULL DEFAULT 8,    -- perda técnica %

  -- [{ name, model, bed_mm }]
  machines JSONB NOT NULL DEFAULT '[]'::jsonb,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prod_settings_org ON production_settings(organization_id);

-- ─────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_product_os_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_dev_updated ON product_dev;
CREATE TRIGGER trg_product_dev_updated BEFORE UPDATE ON product_dev
  FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at();

DROP TRIGGER IF EXISTS trg_prod_settings_updated ON production_settings;
CREATE TRIGGER trg_prod_settings_updated BEFORE UPDATE ON production_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- RLS — membros da org
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE product_dev          ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_dev_version  ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_settings  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_dev_select ON product_dev;
CREATE POLICY product_dev_select ON product_dev FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS product_dev_modify ON product_dev;
CREATE POLICY product_dev_modify ON product_dev FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS pdv_select ON product_dev_version;
CREATE POLICY pdv_select ON product_dev_version FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS pdv_modify ON product_dev_version;
CREATE POLICY pdv_modify ON product_dev_version FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS prod_settings_select ON production_settings;
CREATE POLICY prod_settings_select ON production_settings FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS prod_settings_modify ON production_settings;
CREATE POLICY prod_settings_modify ON production_settings FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────
-- GRANTs — tabelas criadas via _admin_exec_sql não herdam os defaults
-- ─────────────────────────────────────────────────────────────────
GRANT ALL ON TABLE public.product_dev          TO service_role;
GRANT ALL ON TABLE public.product_dev_version  TO service_role;
GRANT ALL ON TABLE public.production_settings  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_dev          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_dev_version  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.production_settings  TO authenticated;
