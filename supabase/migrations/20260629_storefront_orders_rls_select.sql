-- 20260629 — RLS SELECT org-scoped em storefront_orders
--
-- DIAGNÓSTICO (auditoria 2026-05-23): a tabela tem RLS HABILITADO mas ZERO
-- policies → deny-all para o role `authenticated`. Não há vazamento (o backend
-- usa service_role, que tem BYPASSRLS). Porém a tela de Entregas do lojista
-- (`/dashboard/loja/entregas`) lê `storefront_orders` DIRETO pelo browser
-- (role authenticated) e voltava VAZIA — bug funcional.
--
-- Fix: policy de SELECT escopada por organização (mesmo padrão da 20260626,
-- via get_user_org_ids()). Lojista lê SÓ os pedidos da própria org; anon não
-- recebe nada (get_user_org_ids vazio); service_role (backend) bypassa. Sem
-- policy de INSERT/UPDATE/DELETE: escrita continua só via backend.

DROP POLICY IF EXISTS storefront_orders_org_select ON public.storefront_orders;
CREATE POLICY storefront_orders_org_select ON public.storefront_orders
  FOR SELECT TO public
  USING (organization_id IN (SELECT get_user_org_ids()));
