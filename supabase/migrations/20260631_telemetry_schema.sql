-- Telemetria — e-Click Insights (Fase 1: schema base).
--
-- Sistema interno de product analytics: captura eventos de uso dos usuários
-- autenticados do SaaS, agrega engajamento e alimenta o dashboard /insights
-- do founder. NÃO confundir com public.storefront_events (comportamento de
-- VISITANTES anônimos da vitrine) — aqui são os USUÁRIOS do dashboard.
--
-- Multi-tenant: todo evento carrega org_id. A ingestão é org-scoped (cada
-- usuário só grava na própria org). O dashboard /insights é cross-org, mas
-- só acessível por platform-admin via backend — por isso estas tabelas têm
-- GRANT apenas pra service_role (frontend NUNCA lê direto) + RLS habilitado
-- como defesa em profundidade (default-deny pra authenticated).
--
-- v1 sem particionamento: volume atual é baixo (~12 usuários). Quando crescer,
-- migramos telemetry_events pra particionamento por dia + drop de >90 dias.

-- ============================================================
-- EVENTOS RAW
-- ============================================================
CREATE TABLE IF NOT EXISTS public.telemetry_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,                       -- auth.users.id (ref lógica)
  session_id    uuid NOT NULL,                       -- telemetry_sessions.id (ref lógica)
  event_name    varchar(80)  NOT NULL,               -- chave canônica do catálogo
  event_type    varchar(20)  NOT NULL DEFAULT 'action',
  module        varchar(40)  NOT NULL,
  feature       varchar(80),
  page_url      text,
  referrer      text,
  duration_ms   integer,
  properties    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- extras livres (sem PII)
  user_agent    text,
  ip_hash       varchar(64),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_te_org_module_time ON public.telemetry_events (org_id, module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_te_user_session    ON public.telemetry_events (user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_te_event_name      ON public.telemetry_events (event_name);
CREATE INDEX IF NOT EXISTS idx_te_created         ON public.telemetry_events (created_at DESC);

COMMENT ON TABLE public.telemetry_events IS
  'Eventos de uso dos usuários autenticados do SaaS (product analytics interno). Alimenta o dashboard /insights do founder.';

-- ============================================================
-- SESSÕES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.telemetry_sessions (
  id               uuid PRIMARY KEY,                  -- gerado client-side
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  duration_s       integer,
  modules_visited  text[]  NOT NULL DEFAULT '{}',
  events_count     integer NOT NULL DEFAULT 0,
  device_type      varchar(20),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ts_org_user_time ON public.telemetry_sessions (org_id, user_id, started_at DESC);

COMMENT ON TABLE public.telemetry_sessions IS
  'Sessões de uso (agrupa eventos de uma visita ao dashboard). Fechadas pelo client (end-session) ou pelo rollup worker após 30min de inatividade.';

-- ============================================================
-- AGREGADO DIÁRIO POR USUÁRIO/MÓDULO (populado pelo rollup worker — Fase 3)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.telemetry_events_daily (
  date           date NOT NULL,
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  module         varchar(40) NOT NULL,
  visits         integer NOT NULL DEFAULT 0,
  total_time_s   integer NOT NULL DEFAULT 0,
  events_count   integer NOT NULL DEFAULT 0,
  features_used  text[]  NOT NULL DEFAULT '{}',
  last_event_at  timestamptz,
  PRIMARY KEY (date, org_id, user_id, module)
);

COMMENT ON TABLE public.telemetry_events_daily IS
  'Agregado diário (usuário × módulo) gerado pelo rollup worker. Base do histórico mesmo após retenção dos eventos raw.';

-- ============================================================
-- HEALTH SCORE POR USUÁRIO (populado pelo engagement worker — Fase 3)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.telemetry_user_engagement (
  org_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  score               integer NOT NULL DEFAULT 0,
  status              varchar(20) NOT NULL DEFAULT 'inactive',  -- power_user|engaged|casual|at_risk|inactive
  weekly_active_days  integer NOT NULL DEFAULT 0,
  weekly_module_count integer NOT NULL DEFAULT 0,
  weekly_time_minutes integer NOT NULL DEFAULT 0,
  trend               varchar(20) NOT NULL DEFAULT 'stable',    -- up|stable|down
  last_seen_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

COMMENT ON TABLE public.telemetry_user_engagement IS
  'Health score 0-100 por usuário, base pro alerta de churn. Atualizado de hora em hora pelo engagement worker.';

-- ============================================================
-- FUNNELS / TASK COMPLETION
-- ============================================================
CREATE TABLE IF NOT EXISTS public.telemetry_task_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  task_name        varchar(60) NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  abandoned_at     timestamptz,
  abandoned_step   varchar(40),
  steps_completed  jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome          varchar(20),                                 -- completed|abandoned
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tta_org_task_time ON public.telemetry_task_attempts (org_id, task_name, started_at DESC);

COMMENT ON TABLE public.telemetry_task_attempts IS
  'Tentativas de tarefas-chave (criar campanha, importar anúncio, etc) pra montar funis e detectar onde o usuário abandona.';

-- ============================================================
-- INSIGHTS GERADOS POR IA (populado pelo ai-insights worker — Fase 4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.telemetry_ai_insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid REFERENCES public.organizations(id) ON DELETE CASCADE,  -- null = insight global de plataforma
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  type            varchar(30) NOT NULL,                          -- usage_drop|churn_risk|task_abandon|healthy_pattern
  severity        varchar(20),                                   -- low|medium|high
  title           text NOT NULL,
  body            text NOT NULL,
  evidence        jsonb,
  recommendation  text,
  resolved        boolean NOT NULL DEFAULT false,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tai_resolved_time ON public.telemetry_ai_insights (resolved, created_at DESC);

COMMENT ON TABLE public.telemetry_ai_insights IS
  'Insights gerados pela IA a partir dos agregados de uso (quedas, churn, abandono, padrões saudáveis).';

-- ============================================================
-- RLS — default-deny pra authenticated (sem policy permissiva).
-- service_role bypassa RLS; é por ele que toda leitura passa.
-- ============================================================
ALTER TABLE public.telemetry_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telemetry_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telemetry_events_daily     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telemetry_user_engagement  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telemetry_task_attempts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telemetry_ai_insights      ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- GRANTS — criação via _admin_exec_sql não herda os default privileges.
-- Só service_role (backend). Sem GRANT pra authenticated: o frontend
-- nunca consulta estas tabelas direto, sempre via backend gated.
-- ============================================================
GRANT ALL ON TABLE public.telemetry_events          TO service_role;
GRANT ALL ON TABLE public.telemetry_sessions        TO service_role;
GRANT ALL ON TABLE public.telemetry_events_daily    TO service_role;
GRANT ALL ON TABLE public.telemetry_user_engagement TO service_role;
GRANT ALL ON TABLE public.telemetry_task_attempts   TO service_role;
GRANT ALL ON TABLE public.telemetry_ai_insights     TO service_role;
