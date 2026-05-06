-- ============================================================
-- Onda 4 / A6 — White-label Store Config
-- Configuração da loja por org (multi-tenant + temas + domain)
-- ============================================================

CREATE TABLE IF NOT EXISTS store_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

  -- Identidade
  store_name        TEXT NOT NULL,
  store_slug        TEXT NOT NULL UNIQUE,
  store_description TEXT,
  logo_url          TEXT,
  favicon_url       TEXT,

  -- Domínio custom
  custom_domain     TEXT,
  domain_verified   BOOLEAN NOT NULL DEFAULT false,
  ssl_status        TEXT    NOT NULL DEFAULT 'pending'
    CHECK (ssl_status IN ('pending','active','failed','none')),

  -- Theme
  theme JSONB NOT NULL DEFAULT '{
    "primary_color":   "#00E5FF",
    "secondary_color": "#09090B",
    "accent_color":    "#22C55E",
    "font_heading":    "Inter",
    "font_body":       "Inter",
    "border_radius":   "8px",
    "layout":          "modern",
    "hero_style":      "full_width",
    "product_card_style": "minimal",
    "footer_style":    "standard"
  }'::jsonb,

  -- SEO
  seo_title         TEXT,
  seo_description   TEXT,
  seo_keywords      TEXT[] NOT NULL DEFAULT '{}',
  og_image_url      TEXT,
  google_analytics_id TEXT,
  meta_pixel_id     TEXT,
  gtm_id            TEXT,

  -- Configurações
  currency           TEXT NOT NULL DEFAULT 'BRL',
  language           TEXT NOT NULL DEFAULT 'pt-BR',
  shipping_enabled   BOOLEAN NOT NULL DEFAULT true,
  payments_enabled   BOOLEAN NOT NULL DEFAULT true,
  whatsapp_widget_enabled BOOLEAN NOT NULL DEFAULT true,
  whatsapp_number    TEXT,
  ai_seller_widget_enabled BOOLEAN NOT NULL DEFAULT true,

  -- Social
  social_links JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Páginas estáticas
  pages JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'setup'
    CHECK (status IN ('setup','active','paused','suspended')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_store_config_slug   ON store_config(store_slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_config_domain ON store_config(custom_domain)
  WHERE custom_domain IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_store_config_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_store_config_updated ON store_config;
CREATE TRIGGER trg_store_config_updated BEFORE UPDATE ON store_config
  FOR EACH ROW EXECUTE FUNCTION public.set_store_config_updated_at();

ALTER TABLE store_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_config_select ON store_config;
CREATE POLICY store_config_select ON store_config FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS store_config_modify ON store_config;
CREATE POLICY store_config_modify ON store_config FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

-- Read público pra storefront SSR
DROP POLICY IF EXISTS store_config_public_read ON store_config;
CREATE POLICY store_config_public_read ON store_config FOR SELECT TO anon
USING (status = 'active');
