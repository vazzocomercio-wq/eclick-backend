-- Sprint F6 — IA Criativo (Entrega 3a: Pipeline de Vídeo via Kling)
--
-- 2 tabelas novas + extensão do ai_usage_log:
--   creative_video_jobs   — job assíncrono de geração (1-5 vídeos)
--   creative_videos       — cada vídeo do job (com aprovação granular)
--   ai_usage_log + 1 coluna (creative_video_id) — nullable, FK SET NULL
--
-- Diferenças vs pipeline de imagens (E2):
--   - Vídeo é async no provider (Kling): submit retorna task_id,
--     worker pollea status até succeed. external_task_id na row.
--   - Custo ~10x maior ($0.20-0.84/vídeo). max_cost_usd default $5.
--   - Cap menor: 1-5 vídeos por job (vs 1-20 pra imagens).
--   - Duration discreto: 5s ou 10s.
--   - aspect_ratio fixo (1:1, 16:9, 9:16) — Kling só suporta esses.
--   - source_image_id opcional: pode usar imagem aprovada do E2 como
--     frame inicial em vez da main_image do produto.
--
-- Rollback:
--   DROP TABLE IF EXISTS creative_videos;
--   DROP TABLE IF EXISTS creative_video_jobs;
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS creative_video_id;

-- =====================================================================
-- 1. creative_video_jobs — job de geração de vídeos
-- =====================================================================
CREATE TABLE IF NOT EXISTS creative_video_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id           uuid NOT NULL REFERENCES creative_products(id) ON DELETE CASCADE,
  briefing_id          uuid NOT NULL REFERENCES creative_briefings(id) ON DELETE CASCADE,
  listing_id           uuid REFERENCES creative_listings(id) ON DELETE SET NULL,
  source_image_id      uuid REFERENCES creative_images(id) ON DELETE SET NULL,
  user_id              uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  status               text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued',
    'generating_prompts',
    'generating_videos',
    'completed',
    'failed',
    'cancelled'
  )),

  -- Configuração do batch
  requested_count      integer NOT NULL CHECK (requested_count BETWEEN 1 AND 5),
  duration_seconds     integer NOT NULL DEFAULT 5 CHECK (duration_seconds IN (5, 10)),
  aspect_ratio         text    NOT NULL DEFAULT '1:1' CHECK (aspect_ratio IN ('1:1', '16:9', '9:16')),
  model_name           text    NOT NULL DEFAULT 'kling-v2-master',

  -- Contadores
  completed_count      integer NOT NULL DEFAULT 0,
  failed_count         integer NOT NULL DEFAULT 0,
  approved_count       integer NOT NULL DEFAULT 0,
  rejected_count       integer NOT NULL DEFAULT 0,

  -- Custo (default $5 — 10x cap de imagens)
  max_cost_usd         numeric(10,6) NOT NULL DEFAULT 5.000000,
  total_cost_usd       numeric(10,6) NOT NULL DEFAULT 0,

  -- Prompts
  prompts_generated    jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompts_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,

  error_message        text,
  started_at           timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_video_jobs_active
  ON creative_video_jobs(created_at)
  WHERE status IN ('queued', 'generating_prompts', 'generating_videos');

CREATE INDEX IF NOT EXISTS idx_creative_video_jobs_org
  ON creative_video_jobs(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_video_jobs_product
  ON creative_video_jobs(product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_video_jobs_listing
  ON creative_video_jobs(listing_id) WHERE listing_id IS NOT NULL;

ALTER TABLE creative_video_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_video_jobs_org ON creative_video_jobs;
CREATE POLICY creative_video_jobs_org ON creative_video_jobs FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_video_jobs TO service_role;

-- =====================================================================
-- 2. creative_videos — uma row por vídeo gerado
-- =====================================================================
CREATE TABLE IF NOT EXISTS creative_videos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                uuid NOT NULL REFERENCES creative_video_jobs(id) ON DELETE CASCADE,
  product_id            uuid NOT NULL REFERENCES creative_products(id) ON DELETE CASCADE,
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  position              integer NOT NULL CHECK (position BETWEEN 1 AND 5),
  prompt_text           text NOT NULL,

  status                text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',     -- aguardando submit
    'generating',  -- submetido pro Kling, polling
    'ready',       -- baixado e disponível
    'approved',
    'rejected',
    'failed'
  )),

  -- Config (snapshot do job, pra preservar mesmo se job for editado)
  duration_seconds      integer NOT NULL DEFAULT 5,
  aspect_ratio          text    NOT NULL DEFAULT '1:1',
  model_name            text    NOT NULL DEFAULT 'kling-v2-master',

  -- ID externo retornado pelo Kling (pra polling). Preenchido quando
  -- status='generating'.
  external_task_id      text,

  -- Imagem-fonte (do creative_images se foi uma aprovada, OU NULL pra usar
  -- main_image_storage_path do produto)
  source_image_id       uuid REFERENCES creative_images(id) ON DELETE SET NULL,

  storage_path          text,                 -- {org}/{productId}/videos/{id}.mp4
  thumbnail_path        text,                 -- frame extraído pra preview (futuro)

  generation_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  regenerated_from_id   uuid REFERENCES creative_videos(id) ON DELETE SET NULL,

  approved_at           timestamptz,
  approved_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_at           timestamptz,
  rejected_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  error_message         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_videos_job
  ON creative_videos(job_id, position);

CREATE INDEX IF NOT EXISTS idx_creative_videos_pending
  ON creative_videos(job_id, position)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_creative_videos_polling
  ON creative_videos(updated_at)
  WHERE status = 'generating';

CREATE INDEX IF NOT EXISTS idx_creative_videos_product
  ON creative_videos(product_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_videos_org_status
  ON creative_videos(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_videos_regen
  ON creative_videos(regenerated_from_id)
  WHERE regenerated_from_id IS NOT NULL;

ALTER TABLE creative_videos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_videos_org ON creative_videos;
CREATE POLICY creative_videos_org ON creative_videos FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_videos TO service_role;

-- =====================================================================
-- 3. ai_usage_log — extensão pra rastreio por vídeo
-- =====================================================================
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS creative_video_id uuid
    REFERENCES creative_videos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_usage_log_creative_video_idx
  ON ai_usage_log(creative_video_id, created_at DESC)
  WHERE creative_video_id IS NOT NULL;
