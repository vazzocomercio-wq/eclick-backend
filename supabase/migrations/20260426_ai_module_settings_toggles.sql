-- ── ATENDENTE IA — Onda 1 sessão 3: persist UI toggles ────────────────────
-- Adds 5 BOOLEAN columns to ai_module_settings so the toggles in
-- /atendente-ia/configuracoes (Exibição/Aprendizado/Notificações) actually
-- persist instead of being UI-only state.

ALTER TABLE ai_module_settings
  ADD COLUMN IF NOT EXISTS show_tokens        BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS capture_edits      BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_retrain       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_escalation  BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_daily       BOOLEAN DEFAULT false;
