-- Bootstrap helper #2: RPC `_admin_query_sql` complementa `_admin_exec_sql`.
-- Diferença: este executa SELECT e retorna as rows como jsonb array.
-- Necessário pra Claude inspecionar schema sem o user precisar colar SQL no Studio.
--
-- Uso: scripts/query.mjs <sql> ou via PostgREST:
--   POST /rest/v1/rpc/_admin_query_sql
--   { "sql": "SELECT * FROM ..." }

CREATE OR REPLACE FUNCTION public._admin_query_sql(sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  EXECUTE 'SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (' || sql || ') t' INTO result;
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'error', SQLERRM,
    'state', SQLSTATE
  );
END;
$$;

REVOKE ALL ON FUNCTION public._admin_query_sql(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._admin_query_sql(text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._admin_query_sql(text) TO service_role;
