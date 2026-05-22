-- 20260626_fix_rls_blanket_read_leak.sql
--
-- CORRIGE VAZAMENTO MULTI-TENANT (cross-org data leak).
--
-- ~20 tabelas tinham uma policy de SELECT com USING (true) para o role
-- `authenticated` — resquício da época single-tenant (só Vazzo). No RLS as
-- policies PERMISSIVAS se SOMAM (OR): bastava a `true` passar e o isolamento
-- por organização era anulado. Resultado: QUALQUER usuário logado de QUALQUER
-- org lia dados de TODAS as orgs (catálogo, estoque, PII de clientes, chaves
-- de API, conversas de IA, etc).
--
-- Fase 1: tabelas que JÁ possuem policy org-scoped (por organização) ao lado
--         da blanket → basta remover a blanket; o isolamento volta na hora.
-- Fase 2: tabelas sem policy org-scoped → cria a policy correta ANTES de
--         remover a blanket (senão o acesso legítimo quebraria).
--
-- NÃO mexido (intencional):
--   • service_role (backend) tem policy própria ALL/true — intocada.
--   • marketplace_channels, ai_agent_templates — catálogos GLOBAIS (não são
--     dados de org); leitura aberta é por design.
--   • lead_bridge_links — leitura anônima pública (links de captação).
--   • competitor_alerts — sem caminho de org claro (sem FK) e baixa
--     sensibilidade; tratada em revisão à parte.

-- ════════════════════════════════════════════════════════════════════════
-- Fase 1 — remove a blanket (org-scoped já existe nessas tabelas)
-- ════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated users can read products" ON public.products;
DROP POLICY IF EXISTS auth_read_ai_conv      ON public.ai_conversations;
DROP POLICY IF EXISTS auth_read_ai_msg       ON public.ai_messages;
DROP POLICY IF EXISTS auth_insights          ON public.ai_insights;
DROP POLICY IF EXISTS auth_read_ai_kb        ON public.ai_knowledge_base;
DROP POLICY IF EXISTS auth_settings          ON public.ai_module_settings;
DROP POLICY IF EXISTS auth_read_ai_train     ON public.ai_training_examples;
DROP POLICY IF EXISTS auth_read_ai_analytics ON public.ai_agent_analytics;
DROP POLICY IF EXISTS auth_read_ai_channels  ON public.ai_agent_channels;
DROP POLICY IF EXISTS auth_kb_agent          ON public.ai_agent_knowledge;
DROP POLICY IF EXISTS auth_ml_ads_campaigns  ON public.ml_ads_campaigns;
DROP POLICY IF EXISTS auth_ml_ads_reports    ON public.ml_ads_reports;

-- ════════════════════════════════════════════════════════════════════════
-- Fase 2a — escopo direto por organization_id: cria org-scoped + remove blanket
-- ════════════════════════════════════════════════════════════════════════

-- PII de clientes (CPF/telefone/email) — vazamento mais sensível (LGPD).
DROP POLICY IF EXISTS unified_customers_org_select ON public.unified_customers;
CREATE POLICY unified_customers_org_select ON public.unified_customers
  FOR SELECT TO public
  USING (organization_id IN (SELECT get_user_org_ids()));
DROP POLICY IF EXISTS auth_customers ON public.unified_customers;

-- Chaves de API (cifradas, mas ainda assim sensíveis). Linhas com
-- organization_id NULL são credenciais GLOBAIS, usadas só pelo backend
-- (service_role) — corretamente invisíveis ao frontend após o escopo.
DROP POLICY IF EXISTS api_credentials_org_select ON public.api_credentials;
CREATE POLICY api_credentials_org_select ON public.api_credentials
  FOR SELECT TO public
  USING (organization_id IN (SELECT get_user_org_ids()));
DROP POLICY IF EXISTS auth_read_credentials ON public.api_credentials;

DROP POLICY IF EXISTS ai_agents_org_select ON public.ai_agents;
CREATE POLICY ai_agents_org_select ON public.ai_agents
  FOR SELECT TO public
  USING (organization_id IN (SELECT get_user_org_ids()));
DROP POLICY IF EXISTS auth_read_ai_agents ON public.ai_agents;

DROP POLICY IF EXISTS ai_usage_log_org_select ON public.ai_usage_log;
CREATE POLICY ai_usage_log_org_select ON public.ai_usage_log
  FOR SELECT TO public
  USING (organization_id IN (SELECT get_user_org_ids()));
DROP POLICY IF EXISTS auth_read_ai_usage ON public.ai_usage_log;

-- ════════════════════════════════════════════════════════════════════════
-- Fase 2b — sem organization_id: escopo via o produto dono (product_id)
-- ════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS product_listings_org_select ON public.product_listings;
CREATE POLICY product_listings_org_select ON public.product_listings
  FOR SELECT TO public
  USING (product_id IN (
    SELECT id FROM public.products WHERE organization_id IN (SELECT get_user_org_ids())
  ));
DROP POLICY IF EXISTS auth_read_product_listings ON public.product_listings;

DROP POLICY IF EXISTS product_stock_org_select ON public.product_stock;
CREATE POLICY product_stock_org_select ON public.product_stock
  FOR SELECT TO public
  USING (product_id IN (
    SELECT id FROM public.products WHERE organization_id IN (SELECT get_user_org_ids())
  ));
DROP POLICY IF EXISTS auth_read_product_stock ON public.product_stock;

DROP POLICY IF EXISTS stock_movements_org_select ON public.stock_movements;
CREATE POLICY stock_movements_org_select ON public.stock_movements
  FOR SELECT TO public
  USING (product_id IN (
    SELECT id FROM public.products WHERE organization_id IN (SELECT get_user_org_ids())
  ));
DROP POLICY IF EXISTS auth_read_stock_movements ON public.stock_movements;

DROP POLICY IF EXISTS distribution_recalc_log_org_select ON public.distribution_recalc_log;
CREATE POLICY distribution_recalc_log_org_select ON public.distribution_recalc_log
  FOR SELECT TO public
  USING (product_id IN (
    SELECT id FROM public.products WHERE organization_id IN (SELECT get_user_org_ids())
  ));
DROP POLICY IF EXISTS auth_recalc ON public.distribution_recalc_log;
