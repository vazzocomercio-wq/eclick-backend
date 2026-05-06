-- Sprint F6 — IA Criativo (Entrega 1: Gerador de Anúncio Textual)
--
-- 3 tabelas novas + extensão do ai_usage_log existente:
--   creative_products   — perfil do produto (imagem + dados + análise IA)
--   creative_briefings  — briefing de estilo por marketplace
--   creative_listings   — anúncio textual gerado (título, bullets, ficha, etc.)
--   ai_usage_log + 2 colunas (creative_product_id, creative_operation) — nullables
--
-- RLS: padrão do projeto — auth.uid() + organization_members. Service role bypass.
-- O NestJS opera com supabaseAdmin (service_role), policies servem como camada
-- redundante caso algum endpoint público venha a usar PostgREST direto.
--
-- Rollback:
--   DROP TABLE IF EXISTS creative_listings;
--   DROP TABLE IF EXISTS creative_briefings;
--   DROP TABLE IF EXISTS creative_products;
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS creative_product_id;
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS creative_operation;

-- =====================================================================
-- 1. creative_products — perfil do produto
-- =====================================================================
CREATE TABLE IF NOT EXISTS creative_products (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Dados obrigatórios
  name                     text NOT NULL,
  category                 text NOT NULL,
  brand                    text,
  main_image_url           text NOT NULL,
  main_image_storage_path  text NOT NULL,

  -- Dados técnicos
  dimensions               jsonb NOT NULL DEFAULT '{}'::jsonb,
  color                    text,
  material                 text,
  differentials            text[] NOT NULL DEFAULT '{}',
  target_audience          text,
  sku                      text,
  ean                      text,

  -- Análise da IA (preenchido em /analyze)
  ai_analysis              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Referências opcionais
  reference_images         text[] NOT NULL DEFAULT '{}',
  competitor_links         text[] NOT NULL DEFAULT '{}',
  reference_video_url      text,
  brand_identity_url       text,

  -- Metadados
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'analyzing', 'ready', 'archived'
  )),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_products_org
  ON creative_products(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_products_user
  ON creative_products(user_id);
CREATE INDEX IF NOT EXISTS idx_creative_products_sku
  ON creative_products(organization_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_products_status
  ON creative_products(organization_id, status);

ALTER TABLE creative_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_products_org ON creative_products;
CREATE POLICY creative_products_org ON creative_products FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_products TO service_role;

-- =====================================================================
-- 2. creative_briefings — briefing de estilo
-- =====================================================================
CREATE TABLE IF NOT EXISTS creative_briefings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid NOT NULL REFERENCES creative_products(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  target_marketplace  text NOT NULL CHECK (target_marketplace IN (
    'mercado_livre', 'shopee', 'amazon', 'magalu', 'loja_propria', 'multi'
  )),

  visual_style        text NOT NULL DEFAULT 'clean' CHECK (visual_style IN (
    'premium', 'clean', 'tecnico', 'promocional', 'lifestyle', 'luxo_acessivel'
  )),

  environment         text CHECK (environment IN (
    'cozinha', 'sala', 'quarto', 'banheiro', 'area_gourmet',
    'escritorio', 'area_externa', 'garagem', 'lavanderia',
    'estudio', 'loja', 'neutro', 'custom'
  )),
  custom_environment  text,

  background_color    text NOT NULL DEFAULT '#FFFFFF',
  use_logo            boolean NOT NULL DEFAULT false,
  logo_url            text,
  logo_storage_path   text,

  communication_tone  text NOT NULL DEFAULT 'vendedor' CHECK (communication_tone IN (
    'tecnico', 'vendedor', 'sofisticado', 'direto', 'emocional', 'educativo'
  )),

  image_count         integer NOT NULL DEFAULT 10 CHECK (image_count IN (5, 7, 10, 11)),

  image_format        text NOT NULL DEFAULT '1200x1200' CHECK (image_format IN (
    '1200x1200', '1200x1500', '1000x1000', '800x800'
  )),

  marketplace_rules   jsonb NOT NULL DEFAULT '{}'::jsonb,

  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_briefings_product
  ON creative_briefings(product_id, is_active);
CREATE INDEX IF NOT EXISTS idx_creative_briefings_org
  ON creative_briefings(organization_id);

ALTER TABLE creative_briefings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_briefings_org ON creative_briefings;
CREATE POLICY creative_briefings_org ON creative_briefings FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_briefings TO service_role;

-- =====================================================================
-- 3. creative_listings — anúncio textual gerado
-- =====================================================================
CREATE TABLE IF NOT EXISTS creative_listings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id                uuid NOT NULL REFERENCES creative_products(id) ON DELETE CASCADE,
  briefing_id               uuid NOT NULL REFERENCES creative_briefings(id) ON DELETE CASCADE,
  organization_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Conteúdo principal
  title                     text NOT NULL,
  subtitle                  text,
  description               text NOT NULL,

  bullets                   text[] NOT NULL DEFAULT '{}',
  technical_sheet           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- SEO
  keywords                  text[] NOT NULL DEFAULT '{}',
  search_tags               text[] NOT NULL DEFAULT '{}',
  suggested_category        text,

  -- Extras
  faq                       jsonb NOT NULL DEFAULT '[]'::jsonb,
  commercial_differentials  text[] NOT NULL DEFAULT '{}',

  -- Variações por marketplace (multi-target)
  marketplace_variants      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Versionamento
  version                   integer NOT NULL DEFAULT 1,
  parent_listing_id         uuid REFERENCES creative_listings(id) ON DELETE SET NULL,
  generation_metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,

  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'generating', 'review', 'approved', 'published', 'archived'
  )),

  approved_at               timestamptz,
  approved_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_listings_product
  ON creative_listings(product_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_creative_listings_briefing
  ON creative_listings(briefing_id);
CREATE INDEX IF NOT EXISTS idx_creative_listings_org_status
  ON creative_listings(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_listings_parent
  ON creative_listings(parent_listing_id) WHERE parent_listing_id IS NOT NULL;

ALTER TABLE creative_listings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_listings_org ON creative_listings;
CREATE POLICY creative_listings_org ON creative_listings FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_listings TO service_role;

-- =====================================================================
-- 4. ai_usage_log — extensão pra rastreio de operações Creative
-- =====================================================================
-- Em vez de criar uma tabela paralela (creative_usage_log), estendemos a
-- existente. LlmService continua logando normalmente; quando a chamada vier
-- do módulo Creative, o service preenche creative_product_id + creative_operation.
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS creative_product_id uuid
    REFERENCES creative_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS creative_operation  text;

-- Índice pra dashboards de uso por produto
CREATE INDEX IF NOT EXISTS ai_usage_log_creative_product_idx
  ON ai_usage_log(creative_product_id, created_at DESC)
  WHERE creative_product_id IS NOT NULL;
