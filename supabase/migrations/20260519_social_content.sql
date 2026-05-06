-- ============================================================
-- Onda 3 / S1 — Social Content Generator
-- Conteúdo social gerado por IA para produtos do catálogo.
-- Cada linha = 1 peça de conteúdo pra 1 canal específico.
-- ============================================================

CREATE TABLE IF NOT EXISTS social_content (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id)      ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id),

  -- Canal e formato
  channel         TEXT NOT NULL CHECK (channel IN (
    'instagram_post',
    'instagram_reels',
    'instagram_stories',
    'instagram_carousel',
    'tiktok_video',
    'facebook_post',
    'facebook_ads',
    'google_ads',
    'whatsapp_broadcast',
    'email_marketing'
  )),

  -- Conteúdo — estrutura varia por canal (ver doc abaixo)
  content         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Vincula imagens/vídeo do IA Criativo (M-N por imagem, 1-1 por vídeo)
  creative_image_ids UUID[] NOT NULL DEFAULT '{}',
  creative_video_id  UUID,

  -- Status
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','approved','scheduled','published','archived'
  )),
  scheduled_at    TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  published_url   TEXT,

  -- Versionamento (regenerate cria nova linha apontando pro parent)
  version         INTEGER NOT NULL DEFAULT 1,
  parent_id       UUID REFERENCES social_content(id) ON DELETE SET NULL,

  -- Geração
  generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- DOC: shape de `content` por canal
-- ============================================================
-- instagram_post / facebook_post:
--   { caption, hashtags[], image_suggestion, alt_text, cta }
-- instagram_carousel:
--   { slides:[{caption,image_suggestion}], main_caption, hashtags[] }
-- instagram_reels / tiktok_video:
--   { script, scenes:[{time,action,text_overlay}], audio_suggestion,
--     hashtags[], caption }
-- instagram_stories:
--   { stories:[{type,text,sticker?}], cta }
-- facebook_ads / google_ads:
--   { headlines[], descriptions[], primary_text, cta_type,
--     target_audience_suggestion, budget_suggestion_daily_brl,
--     keywords[], negative_keywords[] }
-- whatsapp_broadcast:
--   { message, include_image, include_link, target_segment }
-- email_marketing:
--   { subject, preview_text, body_html, cta_text, cta_url }

CREATE INDEX IF NOT EXISTS idx_social_content_org
  ON social_content(organization_id);
CREATE INDEX IF NOT EXISTS idx_social_content_product
  ON social_content(product_id);
CREATE INDEX IF NOT EXISTS idx_social_content_channel
  ON social_content(channel);
CREATE INDEX IF NOT EXISTS idx_social_content_status
  ON social_content(status);
CREATE INDEX IF NOT EXISTS idx_social_content_scheduled
  ON social_content(scheduled_at)
  WHERE status = 'scheduled';

-- updated_at trigger (mesmo helper já usado em outras tabelas do schema)
CREATE OR REPLACE FUNCTION public.set_social_content_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_social_content_updated_at ON social_content;
CREATE TRIGGER trg_social_content_updated_at
  BEFORE UPDATE ON social_content
  FOR EACH ROW
  EXECUTE FUNCTION public.set_social_content_updated_at();

-- ============================================================
-- RLS — members da org leem/escrevem
-- ============================================================
ALTER TABLE social_content ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_content_select ON social_content;
CREATE POLICY social_content_select ON social_content
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS social_content_modify ON social_content;
CREATE POLICY social_content_modify ON social_content
  FOR ALL TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );
