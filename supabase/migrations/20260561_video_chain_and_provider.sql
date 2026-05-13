-- F6: encadeamento de vídeos pra atingir 15s+ (Kling/Flow só geram 5-10s).
--
-- Fluxo:
--   1. User pede vídeo de 15s a partir de imagem aprovada.
--   2. Pipeline cria 2 (ou 3) creative_videos encadeados:
--      - Vídeo 1 (chain_position=1): usa imagem aprovada como first_frame, duration 10s
--      - Vídeo 2 (chain_position=2): usa último frame de #1 como first_frame, duration 5s
--      - Vídeo MASTER (chain_position=NULL, is_chain_master=true): vídeo concatenado final
--   3. Quando todos os parts viram 'ready', o ffmpeg helper concatena em MP4 único
--      e cria o master que vai pra UI.
--
-- Provider abstraction: agora cada vídeo registra qual provider gerou (kling/flow)
-- pra poder rastrear custo + qualidade por provider.

-- ── creative_videos: campos de encadeamento + provider ─────────────────

ALTER TABLE creative_videos
  ADD COLUMN IF NOT EXISTS parent_video_id uuid
    REFERENCES creative_videos(id) ON DELETE SET NULL;

ALTER TABLE creative_videos
  ADD COLUMN IF NOT EXISTS chain_position int;  -- 1, 2, 3 (NULL = não é parte de chain ou é o master)

ALTER TABLE creative_videos
  ADD COLUMN IF NOT EXISTS chain_total int;     -- total de parts na cadeia (2, 3, etc)

ALTER TABLE creative_videos
  ADD COLUMN IF NOT EXISTS is_chain_master boolean NOT NULL DEFAULT false;

ALTER TABLE creative_videos
  ADD COLUMN IF NOT EXISTS chain_master_id uuid
    REFERENCES creative_videos(id) ON DELETE SET NULL;

ALTER TABLE creative_videos
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'kling'
    CHECK (provider IN ('kling', 'flow'));

ALTER TABLE creative_videos
  ADD COLUMN IF NOT EXISTS quality text;        -- 'standard' | 'premium' | 'audio-native' | 'fast' | 'economy'

-- ── creative_video_jobs: parâmetros do request original ────────────────

ALTER TABLE creative_video_jobs
  ADD COLUMN IF NOT EXISTS target_duration_seconds int;
  -- duração pedida pelo user (15, 20, 25...). Pipeline divide em parts conforme
  -- duração máx suportada pelo provider escolhido (Kling=10s, Veo=8s).

ALTER TABLE creative_video_jobs
  ADD COLUMN IF NOT EXISTS source_provider text DEFAULT 'kling'
    CHECK (source_provider IN ('kling', 'flow'));

ALTER TABLE creative_video_jobs
  ADD COLUMN IF NOT EXISTS camera_motion text DEFAULT 'dolly-in';
  -- dolly-in (zoom in, padrão) | dolly-out | pan-left | pan-right | tilt-up | tilt-down | orbit | static

-- ── Indexes pra UI buscar masters rápido ───────────────────────────────

CREATE INDEX IF NOT EXISTS idx_creative_videos_chain_master
  ON creative_videos(chain_master_id)
  WHERE chain_master_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creative_videos_parent
  ON creative_videos(parent_video_id)
  WHERE parent_video_id IS NOT NULL;

-- ── Comments ───────────────────────────────────────────────────────────

COMMENT ON COLUMN creative_videos.parent_video_id IS
  'F6: vídeo anterior na cadeia (last_frame de parent foi usado como first_frame deste). NULL se for vídeo 1 da cadeia.';

COMMENT ON COLUMN creative_videos.chain_position IS
  'F6: posição na cadeia (1 = primeiro, 2 = segundo, ...). NULL pra vídeos isolados ou masters.';

COMMENT ON COLUMN creative_videos.is_chain_master IS
  'F6: true quando este é o vídeo concatenado FINAL (MP4 único de 15s+). Não vai pra Kling, é montado por ffmpeg.';

COMMENT ON COLUMN creative_videos.chain_master_id IS
  'F6: aponta pro vídeo master final (concatenação ffmpeg) — usado pra UI agrupar parts.';

COMMENT ON COLUMN creative_videos.provider IS
  'F6: qual provider gerou esse vídeo (kling, flow). Útil pra analytics de custo/qualidade.';

COMMENT ON COLUMN creative_video_jobs.target_duration_seconds IS
  'F6: duração total pedida pelo user (15, 20, 25). Pipeline divide em parts.';

COMMENT ON COLUMN creative_video_jobs.camera_motion IS
  'F6: movimento de câmera padrão pra todos os parts (dolly-in = câmera em direção ao produto).';
