-- Bootstrap: cria o RPC `_admin_exec_sql` que permite o backend (NestJS +
-- service_role key) rodar SQL arbitrário via PostgREST. Espelha o pattern
-- do projeto eclick-active.
--
-- SECURITY DEFINER + permissão só pro service_role — nenhum cliente público
-- pode invocar. Usado pelo `scripts/apply-migration.mjs` pra aplicar
-- migrations sem precisar colar manualmente no Studio.
--
-- PASTE ESSA SQL UMA VEZ NO SQL EDITOR DO SUPABASE STUDIO. Depois disso o
-- helper script aplica todas as migrations futuras automaticamente.

CREATE OR REPLACE FUNCTION public._admin_exec_sql(sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE sql;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'ok',    false,
    'error', SQLERRM,
    'state', SQLSTATE
  );
END;
$$;

REVOKE ALL ON FUNCTION public._admin_exec_sql(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._admin_exec_sql(text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._admin_exec_sql(text) TO service_role;
