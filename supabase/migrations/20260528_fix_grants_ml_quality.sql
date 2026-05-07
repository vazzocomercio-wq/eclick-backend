-- ============================================================
-- HOTFIX — GRANTs faltantes nas tabelas do ml_quality (F7 C1)
-- ============================================================
-- Mesma situacao do 20260527_fix_grants_ondas_3_4: tabelas
-- criadas via _admin_exec_sql nao recebem default privileges,
-- aí supabaseAdmin (service_role) bate em 400 "permission
-- denied for table ml_quality_org_summary".
-- ============================================================

DO $$
DECLARE
  tbl text;
  affected_tables text[] := ARRAY[
    'ml_quality_snapshots',
    'ml_category_attributes',
    'ml_quality_org_summary',
    'ml_quality_sync_logs',
    'ml_quality_score_history'
  ];
BEGIN
  FOREACH tbl IN ARRAY affected_tables LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;
