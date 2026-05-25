-- AI Visibility OS — Dia 8 (parcial): skip_reason em ai_audit_results.
--
-- Anúncios indisponíveis (esgotado/pausado/finalizado), bloqueados pelo
-- marketplace (403) ou inexistentes (404) são PULADOS: geo_score fica null e
-- skip_reason explica o motivo. NÃO retry (são determinísticos).
--
-- Aditivo (só ADD COLUMN nullable) → não afeta jobs em fila nem inserts antigos.

ALTER TABLE public.ai_audit_results ADD COLUMN IF NOT EXISTS skip_reason text;

COMMENT ON COLUMN public.ai_audit_results.skip_reason IS
  'Se preenchido, a análise foi PULADA e geo_score é null. Valores: blocked_by_marketplace (403) | product_not_found (404) | product_unavailable (esgotado/pausado/finalizado).';

-- ============================================================
-- ROLLBACK:
-- ALTER TABLE public.ai_audit_results DROP COLUMN IF EXISTS skip_reason;
-- ============================================================
