-- ════════════════════════════════════════════════════════════════════════
-- HOTFIX — colunas faltantes em email_settings
-- ════════════════════════════════════════════════════════════════════════
-- Sintoma: backend retorna 'Salvo, mas teste falhou: Could not find the
-- "is_verified" column of "email_settings" in the schema cache'
--
-- Causa: tabela email_settings foi criada em prod sem essas 3 colunas
-- (provavelmente versão anterior da migration EM-1). Código TS de
-- EmailSettingsService.testConnection() faz UPDATE em is_verified +
-- last_tested_at + last_test_error → quebra silenciosamente no save
-- mas falha no test ("teste falhou").
--
-- Fix: ALTER TABLE adicionando as 3 colunas. NOTIFY pgrst recarrega
-- schema cache.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS is_verified boolean NOT NULL DEFAULT false;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS last_tested_at timestamptz;
ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS last_test_error text;

NOTIFY pgrst, 'reload schema';
