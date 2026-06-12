-- F17-C · Escopo por conta (operador responsável por conta).
--
-- Camada ORTOGONAL ao RBAC de ação (20260660): user_roles diz O QUE o user
-- pode fazer; user_account_scopes diz EM QUAIS CONTAS de marketplace ele
-- enxerga/age. Semântica:
--   • user SEM linhas aqui  → irrestrito (vê todas as contas da org) — é o
--     default retrocompatível: owners/admins não precisam de nada.
--   • user COM linhas       → só enxerga as contas listadas (whitelist).
--
-- account_key por plataforma:
--   mercadolivre → seller_id (texto)        ex: '2290161131'
--   shopee       → shop_id   (texto)        ex: '1548515404'
--   tiktok_shop  → shop_id   (texto)        ex: 'BRLCXULW9W'
--   storefront   → 'loja'    (Loja Própria é conta única por org)

CREATE TABLE IF NOT EXISTS public.user_account_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform        text NOT NULL CHECK (platform IN ('mercadolivre','shopee','tiktok_shop','storefront')),
  account_key     text NOT NULL,
  account_label   text,
  granted_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, platform, account_key)
);

CREATE INDEX IF NOT EXISTS idx_user_account_scopes_org_user
  ON public.user_account_scopes (organization_id, user_id);

COMMENT ON TABLE public.user_account_scopes IS
  'F17-C: whitelist de contas de marketplace por user. Sem linhas = irrestrito.';

ALTER TABLE public.user_account_scopes ENABLE ROW LEVEL SECURITY;

-- SELECT: o próprio user vê o próprio escopo; owner/admin da org vê todos.
DROP POLICY IF EXISTS uas_select ON public.user_account_scopes;
CREATE POLICY uas_select ON public.user_account_scopes
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = user_account_scopes.organization_id
        AND m.user_id = auth.uid()
        AND m.role IN ('owner','admin')
    )
  );

-- Writes: somente service_role (backend) — mutações passam pelo endpoint
-- gated por RBAC (team.manage_roles).

-- Gotcha J da skill: tabela criada via _admin_exec_sql não herda default
-- privileges — sem GRANT explícito até o service_role bate em
-- "permission denied" (RLS é layer 2, GRANT é layer 1).
GRANT ALL ON TABLE public.user_account_scopes TO service_role;
GRANT SELECT ON TABLE public.user_account_scopes TO authenticated;
