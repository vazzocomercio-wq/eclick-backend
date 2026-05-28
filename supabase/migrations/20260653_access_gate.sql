-- F17-A · Gate de acesso (signup fechado, aprovação manual + planos)
-- Sprint paralela à F17-B (RBAC) — sem conflito de schema.
-- Mais detalhes: project_eclick_saas / TaskList #68-#75.

-- ─── 1. Catálogo de planos ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.access_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text,
  target           text NOT NULL CHECK (target IN ('saas','active','combo')),
  price_brl        numeric(10,2),
  billing_period   text NOT NULL DEFAULT 'monthly'
                     CHECK (billing_period IN ('monthly','yearly','onetime')),
  enabled_modules  text[] NOT NULL DEFAULT '{}',
  features         jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_order    int NOT NULL DEFAULT 100,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.access_plans IS 'Planos da plataforma e-Click. enabled_modules casa 1-a-1 com MODULE_CATALOG do frontend (src/lib/modules.ts).';
COMMENT ON COLUMN public.access_plans.target IS 'saas = só plataforma SaaS; active = só Active; combo = ambos.';

-- Seeds — 4 planos com defaults plausíveis. Preços ficam NULL (user define).
INSERT INTO public.access_plans (key, name, description, target, billing_period, enabled_modules, display_order) VALUES
  ('starter', 'Starter',
   'Plano inicial: anúncios ML, catálogo, pedidos, loja própria, compras.',
   'saas', 'monthly',
   ARRAY['marketplace','loja','compras','dropship'],
   10),
  ('pro', 'Pro',
   'Tudo do Starter + CRM, IA criativa, anúncios, atendente IA, analytics.',
   'saas', 'monthly',
   ARRAY['marketplace','loja','compras','dropship','crm','producao','atendente-ia','ads','analytics'],
   20),
  ('max', 'Max',
   'Tudo do Pro + Active completo, AI Visibility (GEO), Inteligência, Fulfillment WMS.',
   'combo', 'monthly',
   ARRAY['marketplace','loja','compras','dropship','crm','producao','atendente-ia','ads','analytics','active','ai-visibility','inteligencia','fulfillment'],
   30),
  ('active', 'Active',
   'Apenas o Active: Inbox unificado, CRM, automações de mensageria.',
   'active', 'monthly',
   ARRAY['active','crm'],
   40)
ON CONFLICT (key) DO NOTHING;

-- ─── 2. Solicitações de acesso (form público) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.access_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Dados de contato
  name                 text NOT NULL,
  email                text NOT NULL,
  phone                text,
  company              text,
  message              text,
  requested_plan_key   text REFERENCES public.access_plans(key) ON DELETE SET NULL,
  -- Status
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','paid','provisioned','cancelled')),
  -- Pagamento (fase 2)
  payment_provider     text CHECK (payment_provider IN ('stripe','mercadopago')),
  external_session_id  text,
  external_payment_id  text,
  paid_at              timestamptz,
  -- Aprovação
  reviewed_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at          timestamptz,
  rejection_reason     text,
  notes                text,
  -- Provisionamento
  provisioned_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provisioned_org_id   uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  provisioned_at       timestamptz,
  -- Auditoria
  ip_address           inet,
  user_agent           text,
  source               text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON public.access_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_requests_email  ON public.access_requests (lower(email));

COMMENT ON TABLE public.access_requests IS 'Pedidos de acesso à plataforma. Submetidos via /solicitar-acesso. Aprovação cria auth.user + org + subscription.';

-- ─── 3. Assinaturas (org → plano) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id                  uuid NOT NULL REFERENCES public.access_plans(id),
  status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('trial','active','past_due','cancelled','expired','suspended')),
  source                   text NOT NULL DEFAULT 'manual'
                             CHECK (source IN ('manual','stripe','mercadopago')),
  external_subscription_id text,
  trial_until              timestamptz,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancelled_at             timestamptz,
  cancel_reason            text,
  access_request_id        uuid REFERENCES public.access_requests(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Cada org no máximo 1 subscription ativa simultânea
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_org_active
  ON public.subscriptions (organization_id)
  WHERE status IN ('trial','active');

CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON public.subscriptions (organization_id);

COMMENT ON TABLE public.subscriptions IS 'Assinaturas ativas org → plano. Aprovação espelha plan.enabled_modules em organizations.enabled_modules (gating de menu).';

-- ─── 4. GRANTs ─────────────────────────────────────────────────────────
GRANT ALL ON public.access_plans TO service_role;
GRANT SELECT ON public.access_plans TO authenticated, anon;

GRANT ALL ON public.access_requests TO service_role;
GRANT INSERT ON public.access_requests TO anon;
GRANT SELECT, UPDATE ON public.access_requests TO authenticated;

GRANT ALL ON public.subscriptions TO service_role;
GRANT SELECT ON public.subscriptions TO authenticated;

-- ─── 5. RLS ────────────────────────────────────────────────────────────
ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS access_requests_anon_insert ON public.access_requests;
CREATE POLICY access_requests_anon_insert
  ON public.access_requests
  FOR INSERT TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS access_requests_admin_all ON public.access_requests;
CREATE POLICY access_requests_admin_all
  ON public.access_requests
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid()
        AND lower(u.email) = 'vazzocomercio@gmail.com'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid()
        AND lower(u.email) = 'vazzocomercio@gmail.com'
    )
  );

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_org_select ON public.subscriptions;
CREATE POLICY subscriptions_org_select
  ON public.subscriptions
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members
      WHERE user_id = auth.uid()
    )
  );

-- ─── 6. Trigger updated_at ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_access_gate_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS tg_access_plans_updated   ON public.access_plans;
CREATE TRIGGER tg_access_plans_updated
  BEFORE UPDATE ON public.access_plans
  FOR EACH ROW EXECUTE FUNCTION public.tg_access_gate_set_updated_at();

DROP TRIGGER IF EXISTS tg_access_requests_updated ON public.access_requests;
CREATE TRIGGER tg_access_requests_updated
  BEFORE UPDATE ON public.access_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_access_gate_set_updated_at();

DROP TRIGGER IF EXISTS tg_subscriptions_updated   ON public.subscriptions;
CREATE TRIGGER tg_subscriptions_updated
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.tg_access_gate_set_updated_at();
