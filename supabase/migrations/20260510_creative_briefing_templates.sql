-- Sprint F6 — IA Criativo (melhoria #2: templates de briefing)
--
-- Templates por org. Cada user tem N templates (ex: "Loja minimalista",
-- "Promocional Black Friday") e reusa como base no wizard de novo produto.
--
-- is_default: 1 template marcado como default vira pré-selecionado no wizard.
-- Apenas 1 default por org — partial unique index.

CREATE TABLE IF NOT EXISTS creative_briefing_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  name                text NOT NULL,
  description         text,

  -- Mesmos fields do creative_briefings (sem product_id obviamente)
  target_marketplace  text NOT NULL CHECK (target_marketplace IN (
    'mercado_livre', 'shopee', 'amazon', 'magalu', 'loja_propria', 'multi'
  )),
  visual_style        text NOT NULL DEFAULT 'clean',
  environment         text,
  custom_environment  text,
  background_color    text NOT NULL DEFAULT '#FFFFFF',
  use_logo            boolean NOT NULL DEFAULT false,
  logo_url            text,
  logo_storage_path   text,
  communication_tone  text NOT NULL DEFAULT 'vendedor',
  image_count         integer NOT NULL DEFAULT 10 CHECK (image_count IN (5, 7, 10, 11)),
  image_format        text NOT NULL DEFAULT '1200x1200',

  is_default          boolean NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_briefing_templates_org
  ON creative_briefing_templates(organization_id, created_at DESC);

-- Apenas 1 default por org
CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_briefing_templates_default
  ON creative_briefing_templates(organization_id)
  WHERE is_default = true;

ALTER TABLE creative_briefing_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_briefing_templates_org ON creative_briefing_templates;
CREATE POLICY creative_briefing_templates_org ON creative_briefing_templates FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_briefing_templates TO service_role;
