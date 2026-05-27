-- 20260649_tiktok_shop_credentials.sql
-- TikTok Shop (Personalizado) — credenciais OAuth da loja por organização.
-- O bundle de tokens (access/refresh) fica CIFRADO (AES-256-GCM via
-- MARKETPLACE_CONFIG_KEY) em credentials_encrypted. Só o backend (service_role)
-- toca nessa tabela — RLS on + 0 policies = deny-all pra authenticated/anon.

CREATE TABLE IF NOT EXISTS public.tiktok_shop_credentials (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  open_id               text,
  seller_name           text,
  region                text,
  shop_id               text,
  shop_cipher           text,
  credentials_encrypted text NOT NULL,
  scopes                text[] NOT NULL DEFAULT '{}',
  access_expires_at     timestamptz,
  refresh_expires_at    timestamptz,
  status                text NOT NULL DEFAULT 'connected',
  raw                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Uma conexão de loja TikTok Shop por organização (v1).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tiktok_shop_credentials_org
  ON public.tiktok_shop_credentials (organization_id);

ALTER TABLE public.tiktok_shop_credentials ENABLE ROW LEVEL SECURITY;

-- Tabela criada via _admin_exec_sql não herda default privileges → GRANT explícito.
GRANT ALL ON public.tiktok_shop_credentials TO service_role;
