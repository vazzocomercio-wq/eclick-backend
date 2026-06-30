-- ============================================================
-- Product OS — Paletas de cor por categoria
--
-- Cartelas de cor IDEAIS por categoria de produto (decoração, suportes de
-- maquiagem, utensílios, utilidades…), para usar na geração de imagens. Cada
-- categoria pode ter uma paleta PRIMÁRIA (a escolhida). É um recurso PRÓPRIO do
-- Product OS — NÃO toca no IA Criativo. 100% aditivo.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_os_palette (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  category_id     UUID REFERENCES sku_taxonomy(id) ON DELETE SET NULL,  -- categoria (sku_taxonomy kind=categoria); null = geral
  colors          JSONB NOT NULL DEFAULT '[]',   -- [{hex, label, input_id?}]
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE, -- a paleta escolhida da categoria
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pospalette_org ON product_os_palette(organization_id, category_id);
-- só UMA paleta primária por (org, categoria)
CREATE UNIQUE INDEX IF NOT EXISTS ux_pospalette_primary ON product_os_palette(organization_id, category_id)
  WHERE is_primary AND category_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_product_os_palette_updated ON product_os_palette;
CREATE TRIGGER trg_product_os_palette_updated BEFORE UPDATE ON product_os_palette
  FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at();

ALTER TABLE product_os_palette ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pospalette_select ON product_os_palette;
CREATE POLICY pospalette_select ON product_os_palette FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS pospalette_modify ON product_os_palette;
CREATE POLICY pospalette_modify ON product_os_palette FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

GRANT ALL ON TABLE public.product_os_palette TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_os_palette TO authenticated;
