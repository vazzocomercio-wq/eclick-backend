-- F4 (sessão 2026-05-14) — Audit trail das tarefas de cadastro despachadas
-- pelo gestor pro operador (cards no Active CRM via automation-bridge).
--
-- 1 linha por (product_id, operator) — idempotência reforça via dedup_key
-- no Active. Aqui guardamos referência cruzada pra:
--   - rastrear quem cuida do quê
--   - receber callback quando task ficar completed
--   - exibir histórico de "produtos despachados" pro gestor

CREATE TABLE IF NOT EXISTS public.product_operator_assignments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id               uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  dispatched_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Operador é user do Active CRM (não validamos FK aqui pois é cross-project)
  operator_user_id         uuid NOT NULL,
  -- Pipeline + stage do Active escolhidos no momento do despacho
  active_pipeline_id       uuid NOT NULL,
  active_stage_id          uuid NOT NULL,
  -- IDs retornados pelo Active após criação
  active_deal_id           uuid,
  active_task_id           uuid,
  due_date                 timestamptz,
  -- Snapshot dos campos faltando no momento do despacho (pra task description)
  missing_fields_snapshot  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Status local: open (acabou de despachar) → in_progress → completed | cancelled
  -- Atualizado por callback do Active (POST /products/cadastro-callback) ou
  -- pelo cron diário que re-avalia completeness.
  status                   text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','in_progress','completed','cancelled','failed')),
  -- Dedup determinístico: 1 assignment OPEN por produto. Permite reabrir
  -- após cancelled/completed se produto voltar a ficar incompleto.
  dedup_key                text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz
);

-- Apenas 1 assignment OPEN/IN_PROGRESS por produto (deixa fechar e reabrir)
CREATE UNIQUE INDEX IF NOT EXISTS idx_poa_open_per_product
  ON public.product_operator_assignments (organization_id, product_id)
  WHERE status IN ('open', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_poa_org_status_created
  ON public.product_operator_assignments (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_poa_active_task
  ON public.product_operator_assignments (active_task_id)
  WHERE active_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_poa_operator
  ON public.product_operator_assignments (organization_id, operator_user_id, status);

ALTER TABLE public.product_operator_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS poa_select ON public.product_operator_assignments;
CREATE POLICY poa_select ON public.product_operator_assignments
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS poa_service ON public.product_operator_assignments;
CREATE POLICY poa_service ON public.product_operator_assignments
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON public.product_operator_assignments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_operator_assignments TO authenticated;

COMMENT ON TABLE public.product_operator_assignments IS
  'F4 (2026-05-14): tarefas de cadastro despachadas pro Active CRM via automation-bridge. 1 OPEN por produto.';
