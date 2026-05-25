-- AI Visibility OS — Dia 1 (reconcile): aditivo sobre 20260639.
--
-- As tabelas base já existem (migration 20260639, aplicada). Este arquivo só
-- ADICIONA colunas pedidas no spec do Dia 1 — não recria nada. Idempotente.
--
-- Modelo de `platform`: passa a significar o MARKETPLACE de origem da URL
-- (ml|shopee|amazon|generic). O motor de IA alvo (chatgpt|perplexity|...) vai
-- na coluna nova `ai_engine`. Tabelas estão vazias, então a mudança de
-- semântica é gratuita.

ALTER TABLE public.ai_audit_jobs    ADD COLUMN IF NOT EXISTS requested_by uuid;                       -- auth.users.id (ref lógica)
ALTER TABLE public.ai_audit_jobs    ADD COLUMN IF NOT EXISTS cost_usd     numeric(10,4) NOT NULL DEFAULT 0;
ALTER TABLE public.ai_audit_jobs    ADD COLUMN IF NOT EXISTS ai_engine    varchar(20);                  -- motor de IA alvo (null = todos)
ALTER TABLE public.ai_audit_results ADD COLUMN IF NOT EXISTS raw_scraped_data jsonb;

COMMENT ON COLUMN public.ai_audit_jobs.platform     IS 'marketplace de origem da URL: ml|shopee|amazon|generic';
COMMENT ON COLUMN public.ai_audit_jobs.ai_engine    IS 'motor de IA alvo: chatgpt|perplexity|gemini|google_ai_overview|copilot (null = todos)';
COMMENT ON COLUMN public.ai_audit_jobs.requested_by IS 'auth.users.id que solicitou a auditoria (ref lógica, sem FK cross-schema)';
COMMENT ON COLUMN public.ai_audit_jobs.cost_usd     IS 'custo acumulado da auditoria em USD (chamadas de IA/scraping)';
COMMENT ON COLUMN public.ai_audit_results.raw_scraped_data IS 'payload bruto coletado (HTML/JSON) antes da pontuação';

-- ============================================================
-- ROLLBACK (funcional) — rodar este bloco pra reverter o Dia 1 reconcile:
-- ALTER TABLE public.ai_audit_jobs    DROP COLUMN IF EXISTS requested_by;
-- ALTER TABLE public.ai_audit_jobs    DROP COLUMN IF EXISTS cost_usd;
-- ALTER TABLE public.ai_audit_jobs    DROP COLUMN IF EXISTS ai_engine;
-- ALTER TABLE public.ai_audit_results DROP COLUMN IF EXISTS raw_scraped_data;
-- ============================================================
