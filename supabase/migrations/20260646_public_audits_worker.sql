-- AI Visibility OS — worker da Auditoria GEO pública (Sprint 2a).
-- DB-como-fila (sem Redis): o worker reclama a auditoria via started_at (CAS)
-- e o tick @Cron reprocessa as travadas. attempts corta o retry.

ALTER TABLE public.public_audits ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE public.public_audits ADD COLUMN IF NOT EXISTS attempts   int NOT NULL DEFAULT 0;

-- Índice parcial pro tick achar as auditorias em andamento rápido.
CREATE INDEX IF NOT EXISTS idx_public_audits_running
  ON public.public_audits (created_at) WHERE status = 'running';

-- ============================================================
-- ROLLBACK:
-- DROP INDEX IF EXISTS public.idx_public_audits_running;
-- ALTER TABLE public.public_audits DROP COLUMN IF EXISTS attempts;
-- ALTER TABLE public.public_audits DROP COLUMN IF EXISTS started_at;
-- ============================================================
