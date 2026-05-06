-- Sprint F6 — IA Criativo (Entrega 2: Pipeline de 10 Imagens)
--
-- 2 tabelas novas + extensão do ai_usage_log:
--   creative_image_jobs   — job assíncrono de geração (10 imagens por padrão)
--   creative_images       — cada imagem do job (com aprovação granular)
--   ai_usage_log + 1 coluna (creative_image_id) — nullable, FK SET NULL
--
-- Worker async pega jobs status='queued' → gera 10 prompts (Sonnet) →
-- gera N imagens (gpt-image-1 com sourceImageUrl da imagem do produto) →
-- atualiza status. Frontend faz polling no GET /creative/image-jobs/:id.
--
-- Aprovação granular: cada creative_images vira approved/rejected/failed
-- independente. User pode regenerar apenas a posição rejeitada (cria nova
-- row com regenerated_from_id apontando pra original).
--
-- Custo: hard limit por job em max_cost_usd (default $1 USD). Worker
-- cancela job se total_cost_usd > max_cost_usd antes de disparar a próxima.
--
-- Rollback:
--   DROP TABLE IF EXISTS creative_images;
--   DROP TABLE IF EXISTS creative_image_jobs;
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS creative_image_id;

-- =====================================================================
-- 1. creative_image_jobs — job de geração (1 job = N imagens)
-- =====================================================================
CREATE TABLE IF NOT EXISTS creative_image_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id           uuid NOT NULL REFERENCES creative_products(id) ON DELETE CASCADE,
  briefing_id          uuid NOT NULL REFERENCES creative_briefings(id) ON DELETE CASCADE,
  listing_id           uuid REFERENCES creative_listings(id) ON DELETE SET NULL,
  user_id              uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  status               text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued',
    'generating_prompts',
    'generating_images',
    'completed',
    'failed',
    'cancelled'
  )),

  -- Contadores (atualizados pelo worker)
  requested_count      integer NOT NULL CHECK (requested_count BETWEEN 1 AND 20),
  completed_count      integer NOT NULL DEFAULT 0,
  failed_count         integer NOT NULL DEFAULT 0,
  approved_count       integer NOT NULL DEFAULT 0,
  rejected_count       integer NOT NULL DEFAULT 0,

  -- Custo
  max_cost_usd         numeric(10,6) NOT NULL DEFAULT 1.000000,
  total_cost_usd       numeric(10,6) NOT NULL DEFAULT 0,

  -- Prompts gerados pela IA (array de N strings + metadata)
  prompts_generated    jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompts_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Erro fatal (se status='failed')
  error_message        text,

  started_at           timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Worker pega jobs em 'queued' por created_at ASC
CREATE INDEX IF NOT EXISTS idx_creative_image_jobs_queued
  ON creative_image_jobs(created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_creative_image_jobs_org
  ON creative_image_jobs(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_image_jobs_product
  ON creative_image_jobs(product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_image_jobs_listing
  ON creative_image_jobs(listing_id) WHERE listing_id IS NOT NULL;

ALTER TABLE creative_image_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_image_jobs_org ON creative_image_jobs;
CREATE POLICY creative_image_jobs_org ON creative_image_jobs FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_image_jobs TO service_role;

-- =====================================================================
-- 2. creative_images — uma row por imagem gerada
-- =====================================================================
CREATE TABLE IF NOT EXISTS creative_images (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                uuid NOT NULL REFERENCES creative_image_jobs(id) ON DELETE CASCADE,
  product_id            uuid NOT NULL REFERENCES creative_products(id) ON DELETE CASCADE,
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Posição na sequência (1..N). Define ordem de exibição.
  position              integer NOT NULL CHECK (position BETWEEN 1 AND 20),

  -- Prompt usado pra gerar esta imagem específica
  prompt_text           text NOT NULL,

  -- Status individual da imagem
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'generating',
    'ready',
    'approved',
    'rejected',
    'failed'
  )),

  -- Storage path no bucket `creative` (ex: {org}/{productId}/images/{uuid}.png).
  -- NULL enquanto status='pending' ou 'generating', preenchido em 'ready'.
  storage_path          text,

  -- Metadados da geração (provider, model, cost_usd, latency_ms, fallback_used)
  generation_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Regeneração: se esta imagem é uma regeração de outra, aponta pra original
  regenerated_from_id   uuid REFERENCES creative_images(id) ON DELETE SET NULL,

  approved_at           timestamptz,
  approved_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_at           timestamptz,
  rejected_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  error_message         text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Lookup principal: imagens de um job ordenadas
CREATE INDEX IF NOT EXISTS idx_creative_images_job
  ON creative_images(job_id, position);

-- Lookup por produto (independente do job — útil pra ver todas as imagens de um produto)
CREATE INDEX IF NOT EXISTS idx_creative_images_product
  ON creative_images(product_id, status, created_at DESC);

-- Filtro de aprovação
CREATE INDEX IF NOT EXISTS idx_creative_images_org_status
  ON creative_images(organization_id, status, created_at DESC);

-- Worker pega imagens 'pending' por job
CREATE INDEX IF NOT EXISTS idx_creative_images_pending
  ON creative_images(job_id, position)
  WHERE status = 'pending';

-- Lookup de regenerações
CREATE INDEX IF NOT EXISTS idx_creative_images_regen
  ON creative_images(regenerated_from_id)
  WHERE regenerated_from_id IS NOT NULL;

ALTER TABLE creative_images ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_images_org ON creative_images;
CREATE POLICY creative_images_org ON creative_images FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_images TO service_role;

-- =====================================================================
-- 3. ai_usage_log — extensão pra rastrear custo por imagem específica
-- =====================================================================
-- Cada call de gpt-image-1 vira 1 linha em ai_usage_log com creative_image_id.
-- Permite drill-down: total custo de imagens vs prompts vs análise vs listing.
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS creative_image_id uuid
    REFERENCES creative_images(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_usage_log_creative_image_idx
  ON ai_usage_log(creative_image_id, created_at DESC)
  WHERE creative_image_id IS NOT NULL;
