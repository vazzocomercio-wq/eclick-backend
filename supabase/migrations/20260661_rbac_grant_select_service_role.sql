-- F17-B4 fix · GRANT SELECT pro service_role nas 4 tabelas RBAC.
--
-- A migration `20260660_rbac_foundation.sql` deu INSERT/UPDATE/DELETE
-- pro service_role mas esqueceu SELECT. service_role tem BYPASSRLS,
-- mas SEM GRANT SELECT a tabela é inacessível pelo backend (que usa
-- supabaseAdmin com service_role key).
--
-- Sintoma sem este fix: PermissionService.load() devolve
-- `42501 permission denied for table user_roles`, e o endpoint
-- /access/me/permissions retorna { permissions: [], roles: [] } pra
-- TODOS os users (mesmo Vazzo owner com 59 perms seedadas).
--
-- Aplicado ao vivo via _admin_exec_sql 2026-05-28 antes do push, este
-- arquivo é só histórico pra que recriar o ambiente do zero não
-- reproduza o bug.

GRANT SELECT ON public.permissions      TO service_role;
GRANT SELECT ON public.roles            TO service_role;
GRANT SELECT ON public.role_permissions TO service_role;
GRANT SELECT ON public.user_roles       TO service_role;
