-- A `organizations` e a `organization_members` foram criadas fora de
-- migration (dashboard / _admin_exec_sql) e a role `service_role` nunca
-- recebeu INSERT/DELETE — só SELECT/UPDATE. Resultado: criar uma
-- organização pelo backend (service-role) ou pela rota /api/onboarding
-- falha com "permission denied for table organizations".
--
-- GRANT ALL torna a service_role plena nessas duas tabelas (a service_role
-- já ignora RLS; isto é só o privilégio de tabela que faltava).

grant all on public.organizations        to service_role;
grant all on public.organization_members to service_role;
