-- A tabela `oauth_state` foi criada originalmente pro Canva OAuth (PKCE),
-- que exige code_verifier. Depois reaproveitamos a mesma tabela pro Meta
-- OAuth — que NÃO usa PKCE. Sem nullable, qualquer OAuth não-PKCE quebra:
--
--   null value in column "code_verifier" of relation "oauth_state"
--     violates not-null constraint
--
-- Já aplicado em prod via _admin_exec_sql em 2026-05-20. Este SQL fica
-- aqui pra outros ambientes (dev local, staging futuro) replicarem.

ALTER TABLE public.oauth_state
  ALTER COLUMN code_verifier DROP NOT NULL;
