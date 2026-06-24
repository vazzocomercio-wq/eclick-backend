-- ============================================================
-- Product OS — Fase 2 (Produção) + Fase 3 (orquestração/Active)
-- 100% aditivo: 8 tabelas novas. Nenhuma tabela existente alterada.
-- Reusa a trigger public.set_product_os_updated_at() criada na Fase 1.
-- RLS por org (forma inline da Fase 1) + GRANTs explícitos.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. product_dev_bom — BOM detalhado (linha por insumo)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_dev_bom (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,
  version_id      UUID REFERENCES product_dev_version(id) ON DELETE SET NULL,
  input_id        UUID,  -- FK lógica p/ production_input (set abaixo); insumo p/ reserva
  kind        TEXT NOT NULL CHECK (kind IN ('filamento','embalagem','etiqueta','mao_de_obra','outro')),
  description TEXT,
  quantity    NUMERIC NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit        TEXT NOT NULL DEFAULT 'un' CHECK (unit IN ('g','kg','un','m','min','h')),
  unit_cost   NUMERIC NOT NULL DEFAULT 0,
  waste_pct   NUMERIC NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bom_org  ON product_dev_bom(organization_id);
CREATE INDEX IF NOT EXISTS idx_bom_dev  ON product_dev_bom(product_dev_id);

-- ─────────────────────────────────────────────────────────────────
-- 2. production_input — estoque de insumos (master) + ledger
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_input (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL DEFAULT 'filamento' CHECK (kind IN ('filamento','embalagem','etiqueta','outro')),
  name     TEXT NOT NULL,
  material TEXT,   -- PLA/PETG/ABS (casa com production_settings.filament_cost_per_kg)
  color    TEXT,
  unit     TEXT NOT NULL DEFAULT 'g' CHECK (unit IN ('g','kg','un','m')),
  quantity          NUMERIC NOT NULL DEFAULT 0,
  reserved_quantity NUMERIC NOT NULL DEFAULT 0,
  reorder_threshold NUMERIC NOT NULL DEFAULT 0,
  cost_per_unit     NUMERIC NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  last_movement_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pinput_org  ON production_input(organization_id);
CREATE INDEX IF NOT EXISTS idx_pinput_kind ON production_input(organization_id, kind);
CREATE INDEX IF NOT EXISTS idx_pinput_mat  ON production_input(organization_id, material) WHERE material IS NOT NULL;

CREATE TABLE IF NOT EXISTS production_input_movement (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  input_id        UUID NOT NULL REFERENCES production_input(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('in','reserve','release','consume','adjust')),
  quantity       NUMERIC NOT NULL,
  balance_after  NUMERIC,
  reference_type TEXT,
  reference_id   TEXT,
  notes          TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pinmov_org   ON production_input_movement(organization_id);
CREATE INDEX IF NOT EXISTS idx_pinmov_input ON production_input_movement(input_id);
CREATE INDEX IF NOT EXISTS idx_pinmov_ref   ON production_input_movement(reference_type, reference_id);
-- idempotência: 1 movimento por (insumo, ref, tipo)
CREATE UNIQUE INDEX IF NOT EXISTS ux_pinmov_ref ON production_input_movement(input_id, reference_type, reference_id, movement_type)
  WHERE reference_id IS NOT NULL;

-- FK lógica do BOM p/ o insumo (depois da tabela existir)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bom_input') THEN
    ALTER TABLE product_dev_bom
      ADD CONSTRAINT fk_bom_input FOREIGN KEY (input_id) REFERENCES production_input(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- 3. production_order — ordem de produção
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_order (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,
  version_id      UUID REFERENCES product_dev_version(id) ON DELETE SET NULL,
  order_number    INTEGER NOT NULL DEFAULT 0,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  machine         TEXT,
  status TEXT NOT NULL DEFAULT 'fila' CHECK (status IN (
    'fila','imprimindo','pausado','falhou','reimpressao','acabamento','qualidade','embalado','disponivel','cancelado'
  )),
  estimated_time_minutes INTEGER,
  actual_time_minutes    INTEGER,
  estimated_filament_g   NUMERIC,
  actual_filament_g      NUMERIC,
  reservation_id      UUID,
  stock_movement_done BOOLEAN NOT NULL DEFAULT false,
  notes        TEXT,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_org    ON production_order(organization_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON production_order(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_po_dev    ON production_order(product_dev_id);

-- ─────────────────────────────────────────────────────────────────
-- 4. print_job — fila de impressão (1 ordem → N jobs)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_job (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  production_order_id UUID NOT NULL REFERENCES production_order(id) ON DELETE CASCADE,
  version_id      UUID REFERENCES product_dev_version(id) ON DELETE SET NULL,
  job_number      INTEGER NOT NULL DEFAULT 1,
  machine         TEXT,
  status TEXT NOT NULL DEFAULT 'fila' CHECK (status IN ('fila','imprimindo','concluido','falhou')),
  filament_used_g    NUMERIC,
  print_time_minutes INTEGER,
  failure_reason     TEXT,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pj_org   ON print_job(organization_id);
CREATE INDEX IF NOT EXISTS idx_pj_order ON print_job(production_order_id);
CREATE INDEX IF NOT EXISTS idx_pj_status ON print_job(organization_id, status);

-- ─────────────────────────────────────────────────────────────────
-- 5. product_dev_quality — checklist de qualidade
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_dev_quality (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,
  version_id      UUID REFERENCES product_dev_version(id) ON DELETE SET NULL,
  production_order_id UUID REFERENCES production_order(id) ON DELETE SET NULL,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{key,label,ok}]
  approved  BOOLEAN NOT NULL DEFAULT false,
  notes     TEXT,
  checked_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pq_org ON product_dev_quality(organization_id);
CREATE INDEX IF NOT EXISTS idx_pq_dev ON product_dev_quality(product_dev_id);

-- ─────────────────────────────────────────────────────────────────
-- 6. product_dev_event — trilha de auditoria / timeline
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_dev_event (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_dev_id  UUID NOT NULL REFERENCES product_dev(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created','status_changed','version_added','version_approved','version_rejected',
    'briefing_generated','cost_computed','dispatched','production_order_created',
    'production_completed','quality_checked','published','archived'
  )),
  payload  JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id UUID,
  is_auto  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pde_dev ON product_dev_event(product_dev_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pde_org ON product_dev_event(organization_id);

-- ─────────────────────────────────────────────────────────────────
-- 7. product_os_config — config do despacho p/ o Active (1 linha/org)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_os_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,
  active_pipeline_id     UUID,
  active_stage_design_id UUID,
  active_stage_print_id  UUID,
  active_stage_publish_id UUID,
  active_assigned_to     UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posconfig_org ON product_os_config(organization_id);

-- ─────────────────────────────────────────────────────────────────
-- updated_at triggers (reusa a função da Fase 1)
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_dev_bom','production_input','production_order','print_job','product_dev_quality','product_os_config'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.set_product_os_updated_at()', t, t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- RLS + GRANTs (forma inline da Fase 1)
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'product_dev_bom','production_input','production_input_movement','production_order',
    'print_job','product_dev_quality','product_dev_event','product_os_config'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %s_select ON %I', t, t);
    EXECUTE format('CREATE POLICY %s_select ON %I FOR SELECT TO authenticated USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %s_modify ON %I', t, t);
    EXECUTE format('CREATE POLICY %s_modify ON %I FOR ALL TO authenticated USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())) WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))', t, t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
  END LOOP;
END $$;
