-- F6: abre CHECK de source_provider/provider em creative_video_jobs e
-- creative_videos pra incluir 'sora' (OpenAI Sora 2 + Sora 2 Pro).
--
-- Antes: CHECK (source_provider IN ('kling', 'flow')) — só os 2 providers
-- originais. Tentativa de criar chained job com sora-2 batia em violação:
--   "violates check constraint creative_video_jobs_source_provider_check"
--
-- Mesmo bug existia em creative_videos.provider.

ALTER TABLE public.creative_video_jobs
  DROP CONSTRAINT IF EXISTS creative_video_jobs_source_provider_check;
ALTER TABLE public.creative_video_jobs
  ADD CONSTRAINT creative_video_jobs_source_provider_check
  CHECK (source_provider IS NULL OR source_provider IN ('kling', 'flow', 'sora'));

ALTER TABLE public.creative_videos
  DROP CONSTRAINT IF EXISTS creative_videos_provider_check;
ALTER TABLE public.creative_videos
  ADD CONSTRAINT creative_videos_provider_check
  CHECK (provider IS NULL OR provider IN ('kling', 'flow', 'sora'));
