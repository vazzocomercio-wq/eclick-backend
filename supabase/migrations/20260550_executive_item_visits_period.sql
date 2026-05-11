-- ============================================
-- F11 Fase 2 — Migration 3.A/3
-- Visitas por item (janela configurável)
-- Fonte: ML /items/{id}/visits/time_window
--
-- period_days configurável (7/14/30/90) — mesma tabela serve várias janelas.
-- daily_breakdown jsonb preserva resposta bruta do ML pra reconstruir
-- sparklines no card sem nova chamada API.
-- error_message + http_status permitem scanner skip-on-error inteligente.
-- UNIQUE inclui period_end → permite histórico semanal (não destrutivo).
-- Index parcial WHERE period_days=7 otimiza query principal do leaderboard.
-- ============================================

CREATE TABLE IF NOT EXISTS public.ml_item_visits_period (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id         bigint NOT NULL,
  ml_item_id        text NOT NULL,                -- MLB-id
  period_days       integer NOT NULL,             -- 7, 14, 30, 90
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  total_visits      bigint NOT NULL DEFAULT 0,
  daily_breakdown   jsonb,                        -- raw [{date, total}] do endpoint
  last_synced_at    timestamptz NOT NULL DEFAULT now(),
  sync_source       text DEFAULT 'ml_api_v1',     -- audit
  http_status       integer,                      -- pra debug de scan
  error_message     text,                         -- NULL = sucesso
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- CONSTRAINTS ───────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_item_visits_period_unique
  ON public.ml_item_visits_period
  (organization_id, seller_id, ml_item_id, period_days, period_end);

ALTER TABLE public.ml_item_visits_period
  ADD CONSTRAINT ck_ml_item_visits_period_dates
  CHECK (period_end >= period_start);

ALTER TABLE public.ml_item_visits_period
  ADD CONSTRAINT ck_ml_item_visits_period_days
  CHECK (period_days IN (7, 14, 30, 90));

-- INDEXES ───────────────────────────────────────────────────────────
-- Leaderboard "últimas 7d" — query mais frequente
CREATE INDEX IF NOT EXISTS ix_ml_item_visits_org_7d_recent
  ON public.ml_item_visits_period (organization_id, period_end DESC, total_visits DESC)
  WHERE period_days = 7;

-- Lookup por item
CREATE INDEX IF NOT EXISTS ix_ml_item_visits_org_item
  ON public.ml_item_visits_period (organization_id, ml_item_id, period_end DESC);

-- Scanner: detectar items com sync atrasado
CREATE INDEX IF NOT EXISTS ix_ml_item_visits_stale
  ON public.ml_item_visits_period (organization_id, last_synced_at);

-- Erros recentes pra alertar
CREATE INDEX IF NOT EXISTS ix_ml_item_visits_errors
  ON public.ml_item_visits_period (organization_id, last_synced_at DESC)
  WHERE error_message IS NOT NULL;

-- TRIGGER updated_at ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_ml_item_visits_period_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ml_item_visits_period_updated_at
  ON public.ml_item_visits_period;

CREATE TRIGGER trg_ml_item_visits_period_updated_at
  BEFORE UPDATE ON public.ml_item_visits_period
  FOR EACH ROW EXECUTE FUNCTION public.tg_ml_item_visits_period_updated_at();

-- RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.ml_item_visits_period ENABLE ROW LEVEL SECURITY;

CREATE POLICY ml_item_visits_org_select
  ON public.ml_item_visits_period FOR SELECT
  USING (
    organization_id IN (
      SELECT om.organization_id
      FROM public.organization_members om
      WHERE om.user_id = auth.uid()
    )
  );

CREATE POLICY ml_item_visits_service_role_all
  ON public.ml_item_visits_period FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- COMMENTS ──────────────────────────────────────────────────────────
COMMENT ON TABLE public.ml_item_visits_period IS
  'F11 Fase 2: visitas por item ML em janela configurável (7/14/30/90d). Populado por cron diário 03:30 BRT que itera items ativos via /items/{id}/visits/time_window. Base da VIEW v_leaderboard_visits_low_conv.';

COMMENT ON COLUMN public.ml_item_visits_period.daily_breakdown IS
  'Raw response do endpoint: array [{date, total}]. Preservado pra reconstruir gráficos diários sem nova chamada.';

COMMENT ON COLUMN public.ml_item_visits_period.error_message IS
  'NULL = sync ok. Preenchido em falha (item closed, deleted, rate-limit, etc) pra scanner pular item no próximo run.';

-- GRANTs explícitos (feedback_grant_admin_exec_sql)
GRANT ALL                              ON public.ml_item_visits_period TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_item_visits_period TO authenticated;
