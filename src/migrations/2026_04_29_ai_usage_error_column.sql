-- Sprint AI-ABS-2 — adiciona coluna error_message em ai_usage_log pra logar
-- chamadas que falharam (Anthropic/OpenAI 5xx, decrypt error, etc). Antes
-- só sucessos eram logados → escuridão pra debug. logUsage() agora roda em
-- try/finally e popula error_message quando falha; NULL em sucesso.
--
-- Rollback:
--   ALTER TABLE ai_usage_log DROP COLUMN IF EXISTS error_message;

BEGIN;

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS error_message text;

COMMIT;
