-- ============================================================
-- HOTFIX adicional — GRANTs em ml_question_suggestions
-- ============================================================
-- A tabela ml_question_suggestions foi criada na migration
-- 20260516_ml_multi_account.sql via _admin_exec_sql RPC e nunca
-- recebeu os defaults privileges do Supabase.
--
-- Sintoma: webhook 'questions' chegava 200, IA gerava sugestão
-- com sucesso (ai_usage_log preenchido), mas INSERT em
-- ml_question_suggestions falhava silenciosamente. Diagnosticado
-- ao testar webhook ML real (perguntas existentes da Vazzo).
--
-- Fix: mesmo pattern dos hotfixes 20260527_fix_grants_ondas_3_4
-- e 20260507b_fix_grants_ml_postsale_intelligence.
-- ============================================================

GRANT ALL ON TABLE public.ml_question_suggestions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ml_question_suggestions TO authenticated;
