-- AI Visibility OS — Dia 3 (orquestrador): estado de fila/retry em ai_audit_jobs.
--
-- Sem Redis no stack → a "fila" é estado no DB processado por @Cron + kick async.
-- Aditivo sobre 20260639/20260640. Só ADD COLUMN (nada de DROP). Idempotente.
--
-- Ciclo de status: pending → processing → completed | (retry → processing)* → failed
-- Worker pega job quando: status IN ('pending','retry') AND (next_retry_at IS NULL
-- OR next_retry_at <= now()) AND deleted_at IS NULL. Backoff: 30s, 2min, 10min,
-- depois marca failed (retry_count > max_retries).

ALTER TABLE public.ai_audit_jobs ADD COLUMN IF NOT EXISTS retry_count   int NOT NULL DEFAULT 0;
ALTER TABLE public.ai_audit_jobs ADD COLUMN IF NOT EXISTS max_retries   int NOT NULL DEFAULT 3;
ALTER TABLE public.ai_audit_jobs ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE public.ai_audit_jobs ADD COLUMN IF NOT EXISTS last_error    text;
ALTER TABLE public.ai_audit_jobs ADD COLUMN IF NOT EXISTS started_at    timestamptz;
ALTER TABLE public.ai_audit_jobs ADD COLUMN IF NOT EXISTS deleted_at    timestamptz;

-- Índice do claim do worker (jobs elegíveis, não deletados).
CREATE INDEX IF NOT EXISTS idx_avj_claim
  ON public.ai_audit_jobs (status, next_retry_at)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN public.ai_audit_jobs.retry_count   IS 'tentativas já falhadas';
COMMENT ON COLUMN public.ai_audit_jobs.next_retry_at IS 'quando o worker pode reprocessar (backoff)';
COMMENT ON COLUMN public.ai_audit_jobs.last_error    IS 'mensagem do último erro de processamento';
COMMENT ON COLUMN public.ai_audit_jobs.deleted_at    IS 'soft delete';

-- ============================================================
-- ROLLBACK (funcional):
-- DROP INDEX IF EXISTS public.idx_avj_claim;
-- ALTER TABLE public.ai_audit_jobs DROP COLUMN IF EXISTS retry_count;
-- ALTER TABLE public.ai_audit_jobs DROP COLUMN IF EXISTS max_retries;
-- ALTER TABLE public.ai_audit_jobs DROP COLUMN IF EXISTS next_retry_at;
-- ALTER TABLE public.ai_audit_jobs DROP COLUMN IF EXISTS last_error;
-- ALTER TABLE public.ai_audit_jobs DROP COLUMN IF EXISTS started_at;
-- ALTER TABLE public.ai_audit_jobs DROP COLUMN IF EXISTS deleted_at;
-- ============================================================
