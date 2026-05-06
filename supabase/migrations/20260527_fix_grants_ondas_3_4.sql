-- ============================================================
-- HOTFIX — GRANTs faltantes nas tabelas das Ondas 3+4
-- ============================================================
-- Tabelas criadas via _admin_exec_sql RPC (postgres role) não
-- recebem os defaults privileges automáticos do Supabase, que
-- normalmente concedem SELECT/INSERT/UPDATE/DELETE pra
-- service_role + authenticated quando uma tabela é criada
-- pela CLI do Supabase.
--
-- Sintoma: API retornava 400 "permission denied for table X"
-- porque o backend (que usa service_role via supabaseAdmin)
-- não tinha permissão de SELECT/etc.
--
-- Solução: GRANTs explícitos. RLS continua sendo o ponto de
-- enforcement de isolation por org — esse é só o nível de
-- privilégio do role.
-- ============================================================

DO $$
DECLARE
  tbl text;
  affected_tables text[] := ARRAY[
    'social_content',
    'social_commerce_channels',
    'social_commerce_products',
    'ads_campaigns',
    'pricing_ai_suggestions',
    'pricing_ai_rules',
    'store_automation_actions',
    'store_automation_config',
    'product_kits',
    'storefront_rules',
    'product_collections',
    'store_config'
  ];
BEGIN
  FOREACH tbl IN ARRAY affected_tables LOOP
    -- service_role: full access (bypassa RLS, mas precisa do GRANT)
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);

    -- authenticated: SELECT/INSERT/UPDATE/DELETE (RLS filtra por org)
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;

-- store_config tem policy explícita pra anon (storefront SSR público)
-- — precisa GRANT SELECT
GRANT SELECT ON TABLE public.store_config TO anon;
