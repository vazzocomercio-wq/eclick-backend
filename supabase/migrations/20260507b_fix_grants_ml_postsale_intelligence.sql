-- ============================================================
-- HOTFIX — GRANTs faltantes nas tabelas do ML Pós-venda (MVP 1)
--          + Intelligence Hub vertical ML (MVP 2)
-- ============================================================
-- Tabelas criadas via _admin_exec_sql RPC (postgres role) não
-- recebem os defaults privileges automáticos do Supabase, que
-- normalmente concedem SELECT/INSERT/UPDATE/DELETE pra
-- service_role + authenticated quando uma tabela é criada via
-- CLI do Supabase.
--
-- Sintoma: API retornava 400 "permission denied for table
-- ml_conversations" no GET /ml/postsale/conversations.
--
-- Solução: GRANTs explícitos. RLS continua sendo o ponto de
-- enforcement de isolation por org — esse é só o nível de
-- privilégio do role. Mesmo pattern de 20260527_fix_grants_ondas_3_4.
-- ============================================================

DO $$
DECLARE
  tbl text;
  affected_tables text[] := ARRAY[
    -- MVP 1 (sprint 20260507_ml_postsale.sql)
    'ml_conversations',
    'ml_messages',
    'ml_ai_suggestions',
    'ml_sla_events',
    'ml_product_knowledge',
    -- MVP 2 (sprint 20260507_intelligence_hub_ml_vertical.sql)
    'ml_claims',
    'ml_seller_reputation_snapshots',
    'claim_removal_candidates'
  ];
BEGIN
  FOREACH tbl IN ARRAY affected_tables LOOP
    -- service_role: full access (bypassa RLS, mas precisa do GRANT base)
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);

    -- authenticated: SELECT/INSERT/UPDATE/DELETE (RLS filtra por org)
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;
