-- F6: abre o CHECK de duration_seconds em creative_video_jobs e creative_videos
-- pra acomodar todas as durações dos 3 providers:
--   Kling: 5, 10
--   Veo:   4, 6, 8
--   Sora:  4, 8, 12
-- E também as durações de chain (15-30s) que rodam como master row.
--
-- Antes: CHECK (duration_seconds IN (5, 10)) — só Kling.
-- Job sob legacy modal com Veo/Sora batia em "violates check constraint".
-- Validação fina por modelo agora vive no pipeline (createJob valida vs
-- supportedDurations do provider) — DB só garante range razoável.

ALTER TABLE public.creative_video_jobs
  DROP CONSTRAINT IF EXISTS creative_video_jobs_duration_seconds_check;
ALTER TABLE public.creative_video_jobs
  ADD CONSTRAINT creative_video_jobs_duration_seconds_check
  CHECK (duration_seconds BETWEEN 1 AND 30);

ALTER TABLE public.creative_videos
  DROP CONSTRAINT IF EXISTS creative_videos_duration_seconds_check;
ALTER TABLE public.creative_videos
  ADD CONSTRAINT creative_videos_duration_seconds_check
  CHECK (duration_seconds BETWEEN 1 AND 30);
