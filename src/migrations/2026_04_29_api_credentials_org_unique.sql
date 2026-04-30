-- Sprint F5-2 / Batch 1.6 — fix multi-tenant em api_credentials.
--
-- Problema: UNIQUE(provider, key_name) atual permite só UMA conexão de
-- cada provider GLOBALMENTE. Em SaaS multi-tenant, conectar Canva da
-- org B sobrescreve a da org A. Bug latente, ainda inofensivo enquanto
-- só Vazzo está ativa, mas trava onboarding de outros clientes.
--
-- Fix: trocar UNIQUE pra (organization_id, provider, key_name).
--
-- Validação prévia (executar antes pra garantir zero duplicatas):
--   SELECT organization_id, provider, key_name, count(*)
--   FROM api_credentials
--   GROUP BY 1,2,3
--   HAVING count(*) > 1;
-- Resultado esperado: 0 rows. Confirmado em 2026-04-29 (apenas Vazzo
-- com anthropic + openai, sem colisões).
--
-- Rollback:
--   ALTER TABLE api_credentials DROP CONSTRAINT api_credentials_org_provider_key_unique;
--   ALTER TABLE api_credentials ADD CONSTRAINT api_credentials_provider_key_name_key
--     UNIQUE (provider, key_name);

BEGIN;

-- ── 1. Drop TODAS as UNIQUE constraints existentes em api_credentials
-- (catch-all defensivo: nome do constraint pode variar conforme migration history)
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'api_credentials'::regclass
      AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE api_credentials DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;

-- ── 2. Cria UNIQUE composto incluindo organization_id
ALTER TABLE api_credentials
  ADD CONSTRAINT api_credentials_org_provider_key_unique
  UNIQUE (organization_id, provider, key_name);

-- ── 3. Index pra performance em lookups por (org, provider, is_active)
CREATE INDEX IF NOT EXISTS api_credentials_org_provider_idx
  ON api_credentials (organization_id, provider, is_active)
  WHERE is_active = true;

COMMIT;
