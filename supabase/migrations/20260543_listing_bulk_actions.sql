-- ============================================================
-- F10 ML Listing Center IA — L4 Sprint 8: Ações em massa + auditoria
-- 1 row por execução de bulk action. Permite UI mostrar histórico,
-- progresso em tempo real e resultados detalhados por item.
-- Spec canônica: docs/ml-listing-center-spec.md
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ml_listing_bulk_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  seller_id BIGINT NOT NULL,
  user_id UUID REFERENCES auth.users(id),

  action_type TEXT NOT NULL CHECK (action_type IN (
    'apply_price_suggestions',
    'activate_automation',
    'pause_automation',
    'fix_fiscal_data',
    'reactivate_paused',
    'pause_listings',
    'snooze_tasks',
    'dismiss_tasks',
    'resolve_tasks_manual'
  )),

  -- Escopo (qualquer um dos 3)
  task_ids UUID[] DEFAULT '{}'::uuid[],
  item_ids TEXT[] DEFAULT '{}'::text[],
  filter_rules JSONB DEFAULT '{}'::jsonb,

  -- Modo
  apply_mode TEXT NOT NULL DEFAULT 'safe' CHECK (apply_mode IN ('safe', 'best_effort', 'dry_run')),

  -- Status + progresso
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'validating', 'executing', 'completed', 'partial', 'failed', 'cancelled'
  )),
  total_count     INTEGER NOT NULL DEFAULT 0,
  validated_count INTEGER DEFAULT 0,
  applied_count   INTEGER DEFAULT 0,
  failed_count    INTEGER DEFAULT 0,
  skipped_count   INTEGER DEFAULT 0,

  -- Resultados por item
  results JSONB DEFAULT '[]'::jsonb,
  -- [{ item_id, status: 'applied'|'failed'|'skipped', message?, ... }]

  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulk_actions_org_seller
  ON public.ml_listing_bulk_actions(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_bulk_actions_status
  ON public.ml_listing_bulk_actions(status);
CREATE INDEX IF NOT EXISTS idx_bulk_actions_type
  ON public.ml_listing_bulk_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_bulk_actions_recent
  ON public.ml_listing_bulk_actions(created_at DESC);

GRANT ALL ON public.ml_listing_bulk_actions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.ml_listing_bulk_actions TO authenticated;

NOTIFY pgrst, 'reload schema';
