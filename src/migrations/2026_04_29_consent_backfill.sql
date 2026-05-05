-- Sprint FIX-ENRICH-1 — backfill de consents pra clientes ativos da org Vazzo.
--
-- Contexto: 4370 unified_customers ativos NÃO têm row em enrichment_consents,
-- bloqueando enrichment via consent.check (retorna false quando data IS NULL).
-- Os consents existentes (3906) usam consent_source='tos_legitimate_interest_v1'
-- ou 'order_purchase_contract_art7v' — base legal LGPD art.7º IX e art.7º V.
--
-- Esta backfill cria 1 row por unified_customer com:
--   identifier_hash = sha256(strip_non_digits(cpf))   -- mesmo do hash.util.ts
--   identifier_type = 'cpf'
--   consent_enrichment = true
--   consent_source = 'backfill_legitimate_interest_v1'
--   customer_id = uc.id (link explícito pra reverse-lookup futuro)
--
-- Idempotente via NOT EXISTS — pode rodar múltiplas vezes.
--
-- Rollback (se precisar reverter ESSE backfill especificamente):
--   DELETE FROM enrichment_consents
--   WHERE consent_source = 'backfill_legitimate_interest_v1'
--   AND organization_id = '4ef1aabd-c209-40b0-b034-ef69dcb66833';

BEGIN;

INSERT INTO enrichment_consents (
  id,
  organization_id,
  customer_id,
  identifier_type,
  identifier_hash,
  consent_enrichment,
  consent_marketing,
  consent_messaging_whatsapp,
  consent_messaging_instagram,
  consent_messaging_tiktok,
  consent_source,
  consent_at
)
SELECT
  gen_random_uuid(),
  uc.organization_id,
  uc.id,
  'cpf',
  encode(sha256(regexp_replace(uc.cpf, '\D', '', 'g')::bytea), 'hex'),
  true,                               -- consent_enrichment
  false,                              -- consent_marketing  (opt-in separado)
  false,                              -- consent_messaging_whatsapp
  false,                              -- consent_messaging_instagram
  false,                              -- consent_messaging_tiktok
  'backfill_legitimate_interest_v1',
  now()
FROM unified_customers uc
WHERE uc.organization_id = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
  AND uc.is_deleted = false
  AND uc.cpf IS NOT NULL
  AND length(regexp_replace(uc.cpf, '\D', '', 'g')) >= 11   -- só CPFs válidos (11+ dígitos)
  AND NOT EXISTS (
    SELECT 1 FROM enrichment_consents ec
    WHERE ec.organization_id = uc.organization_id
      AND ec.identifier_hash = encode(sha256(regexp_replace(uc.cpf, '\D', '', 'g')::bytea), 'hex')
      AND ec.identifier_type = 'cpf'
  )
RETURNING id, identifier_hash;

-- Pra confirmar no SQL Editor após rodar:
--   SELECT consent_source, COUNT(*) FROM enrichment_consents
--   WHERE organization_id = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
--   GROUP BY consent_source ORDER BY 2 DESC;
-- Esperado: aparece nova linha 'backfill_legitimate_interest_v1' com ~4370 rows.

COMMIT;
