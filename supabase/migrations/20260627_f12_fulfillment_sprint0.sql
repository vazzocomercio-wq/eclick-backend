-- ============================================================================
-- F12 FULFILLMENT — SPRINT 0 (fundação de banco)
-- Migration: 20260627_f12_fulfillment_sprint0.sql
-- ============================================================================
--
-- Objetivo do sprint: ELIMINAR ERRO DE SEPARAÇÃO no CD próprio via bipagem
-- obrigatória + dupla checagem (pick → pack) + log auditável de TODA ação.
--
-- Decisões de arquitetura (ver chat de planejamento):
--   • Modelo UNIFICADO: o fulfillment não se prende a `orders` (que é só ML e
--     é flat — 1 linha por item). Introduzimos `fulfillment_orders` que abstrai
--     a ORIGEM do pedido (marketplace / loja própria / B2B). Cada origem é
--     ingerida pra cá; pick/pack/etiqueta operam sempre sobre essa camada.
--       - marketplace → agrupa N linhas de `orders` pelo external_order_id
--       - storefront  → 1 `storefront_orders` (itens em jsonb)
--       - b2b         → entrada manual (não há tabela de pedido B2B hoje)
--   • IA é OPCIONAL e por org (toggles em `fulfillment_settings`, OFF por
--     padrão): triagem de avaria por foto, conferência de pacote por foto,
--     fila de separação inteligente.
--
-- Padrões da casa aplicados:
--   • organization_id (NÃO org_id) + index composto começando por org.
--   • RLS: policy org-scoped via get_user_org_ids() + policy ALL pro
--     service_role (idêntico ao padrão pós-correção de vazamento 20260626).
--   • GRANTs explícitos no fim (tabela criada via _admin_exec_sql não herda
--     default privileges — bug recorrente).
--   • Idempotente: IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════
-- 1) WAREHOUSES — CDs próprios da org
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.warehouses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  code            text NOT NULL,                      -- ex: 'VAZZO-CD01'
  address         jsonb,                              -- {rua, num, cidade, uf, cep}
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_warehouses_org
  ON public.warehouses(organization_id) WHERE is_active = true;


-- ════════════════════════════════════════════════════════════════════════
-- 2) WAREHOUSE_OPERATORS — vínculo user × CD + papel operacional
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.warehouse_operators (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id    uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('picker','packer','supervisor','admin')),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_operators_org
  ON public.warehouse_operators(organization_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_operators_user
  ON public.warehouse_operators(user_id) WHERE is_active = true;


-- ════════════════════════════════════════════════════════════════════════
-- 3) FULFILLMENT_SETTINGS — config por org (1 linha) — toggles de IA OFF
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fulfillment_settings (
  organization_id              uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Toggles de IA (opt-in por org — o lojista liga se quiser)
  ai_damage_triage_enabled     boolean NOT NULL DEFAULT false,  -- avaria por foto
  ai_pack_verification_enabled boolean NOT NULL DEFAULT false,  -- conferência por foto no pack
  ai_smart_queue_enabled       boolean NOT NULL DEFAULT false,  -- fila inteligente
  -- Regra de foto obrigatória na expedição
  photo_required_always        boolean NOT NULL DEFAULT false,
  photo_required_above_cents   integer NOT NULL DEFAULT 15000,  -- R$ 150,00
  photo_required_vip_channels  text[]  NOT NULL DEFAULT '{}'::text[],
  settings                     jsonb   NOT NULL DEFAULT '{}'::jsonb,  -- expansão futura
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);


-- ════════════════════════════════════════════════════════════════════════
-- 4) FULFILLMENT_ORDERS — pedido UNIFICADO a separar (abstrai a origem)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fulfillment_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id     uuid REFERENCES public.warehouses(id),

  source_type      text NOT NULL CHECK (source_type IN ('marketplace','storefront','b2b')),
  source_id        text,                                -- external_order_id (ML) / storefront_orders.id / NULL (b2b manual)
  source_order_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],-- linhas de `orders` (ML multi-item) que compõem este pedido

  channel          text,                                -- 'mercadolivre','shopee','loja','b2b'
  reference        text,                                -- nº amigável (external_order_id / #pedido)
  customer         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- snapshot {name,doc,phone,email,address}
  items_count      integer NOT NULL DEFAULT 0,
  total_cents      integer,

  sla_deadline     timestamptz,                         -- prazo de despacho do marketplace
  priority         integer NOT NULL DEFAULT 100,        -- menor = mais prioritário

  status           text NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','picking','packing','packed','shipped','blocked','cancelled')),
  block_reason     text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Ingestão idempotente: não duplica o mesmo pedido da mesma origem.
  -- (source_id NULL em b2b manual é permitido múltiplas vezes — NULLs são distintos.)
  UNIQUE (organization_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_queue
  ON public.fulfillment_orders(organization_id, warehouse_id, status, priority, sla_deadline)
  WHERE status IN ('received','picking','packing');
CREATE INDEX IF NOT EXISTS idx_fulfillment_orders_org_created
  ON public.fulfillment_orders(organization_id, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
-- 5) PICK_TASKS — 1 task por item a separar
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.pick_tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id         uuid NOT NULL REFERENCES public.warehouses(id),
  fulfillment_order_id uuid NOT NULL REFERENCES public.fulfillment_orders(id) ON DELETE CASCADE,
  product_id           uuid REFERENCES public.products(id) ON DELETE SET NULL,
  sku                  text NOT NULL,
  title                text,
  expected_qty         integer NOT NULL,
  picked_qty           integer NOT NULL DEFAULT 0,
  expected_barcode     text,                               -- código de barras esperado (EAN/GTIN/SKU)
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','in_progress','picked','blocked','cancelled')),
  priority             integer NOT NULL DEFAULT 100,
  sla_deadline         timestamptz,
  assigned_to          uuid REFERENCES auth.users(id),
  picked_at            timestamptz,
  picked_by            uuid REFERENCES auth.users(id),
  block_reason         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pick_tasks_queue
  ON public.pick_tasks(warehouse_id, status, priority, sla_deadline)
  WHERE status IN ('pending','in_progress');
CREATE INDEX IF NOT EXISTS idx_pick_tasks_forder
  ON public.pick_tasks(fulfillment_order_id);
CREATE INDEX IF NOT EXISTS idx_pick_tasks_org
  ON public.pick_tasks(organization_id, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
-- 6) PACK_TASKS — 1 task por pedido (conferência dupla + foto opcional)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.pack_tasks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id           uuid NOT NULL REFERENCES public.warehouses(id),
  fulfillment_order_id   uuid NOT NULL REFERENCES public.fulfillment_orders(id) ON DELETE CASCADE,
  status                 text NOT NULL DEFAULT 'awaiting_pick'
                         CHECK (status IN ('awaiting_pick','ready_to_pack','in_progress','packed','blocked','shipped')),
  requires_photo         boolean NOT NULL DEFAULT false,    -- TRUE se ticket > limite ou canal VIP
  photo_url              text,
  scanned_order_at       timestamptz,                       -- bipagem do pedido libera a conferência
  scanned_by             uuid REFERENCES auth.users(id),
  packed_at              timestamptz,
  packed_by              uuid REFERENCES auth.users(id),
  shipped_at             timestamptz,
  block_reason           text,
  -- IA de conferência por foto (opcional — só roda se ai_pack_verification_enabled)
  ai_verification_passed boolean,
  ai_verification_result jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fulfillment_order_id)
);
CREATE INDEX IF NOT EXISTS idx_pack_tasks_queue
  ON public.pack_tasks(warehouse_id, status)
  WHERE status IN ('ready_to_pack','in_progress');
CREATE INDEX IF NOT EXISTS idx_pack_tasks_org
  ON public.pack_tasks(organization_id, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
-- 7) OPERATOR_ACTIONS — log auditável (TUDO que o operador faz)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.operator_actions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id         uuid REFERENCES public.warehouses(id),
  user_id              uuid NOT NULL REFERENCES auth.users(id),
  action_type          text NOT NULL CHECK (action_type IN (
                         'scan_order','scan_item','scan_mismatch','photo_taken',
                         'pick_complete','pack_complete','damage_reported','label_printed',
                         'block_pick','block_pack','unblock'
                       )),
  pick_task_id         uuid REFERENCES public.pick_tasks(id) ON DELETE CASCADE,
  pack_task_id         uuid REFERENCES public.pack_tasks(id) ON DELETE CASCADE,
  fulfillment_order_id uuid REFERENCES public.fulfillment_orders(id) ON DELETE CASCADE,
  payload              jsonb,                              -- detalhes da ação
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- ~1000 pedidos/dia × ~5 ações = ~150k/mês. Postgres aguenta liso sem partição
-- por ora; particionar por mês depois se o volume escalar.
CREATE INDEX IF NOT EXISTS idx_operator_actions_forder
  ON public.operator_actions(fulfillment_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_actions_user
  ON public.operator_actions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_actions_org_type
  ON public.operator_actions(organization_id, action_type, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
-- 8) DAMAGE_REPORTS — avarias detectadas (com foto + triagem IA opcional)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.damage_reports (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id            uuid NOT NULL REFERENCES public.warehouses(id),
  reported_by             uuid NOT NULL REFERENCES auth.users(id),
  pick_task_id            uuid REFERENCES public.pick_tasks(id),
  fulfillment_order_id    uuid REFERENCES public.fulfillment_orders(id),
  product_id              uuid REFERENCES public.products(id) ON DELETE SET NULL,
  sku                     text NOT NULL,
  severity                text NOT NULL CHECK (severity IN ('minor','major','total_loss')),
  description             text,
  photo_urls              text[] NOT NULL DEFAULT '{}'::text[],   -- bucket fulfillment-photos
  resolution              text CHECK (resolution IN ('discard','return_supplier','sell_as_b','pending')),
  resolved_at             timestamptz,
  resolved_by             uuid REFERENCES auth.users(id),
  -- IA triagem de avaria (opcional — só roda se ai_damage_triage_enabled)
  ai_suggested_severity   text,
  ai_suggested_resolution text,
  ai_confidence           numeric(4,3),
  ai_analysis             jsonb,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_damage_reports_org
  ON public.damage_reports(organization_id, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
-- 9) SHIPMENT_LABELS — etiqueta gerada + rastreio
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.shipment_labels (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  fulfillment_order_id uuid REFERENCES public.fulfillment_orders(id) ON DELETE CASCADE,
  pack_task_id         uuid REFERENCES public.pack_tasks(id),
  marketplace          text NOT NULL,                      -- 'mercadolivre','shopee','loja','b2b'
  tracking_code        text,
  label_format         text CHECK (label_format IN ('ZPL','PDF','PNG')),
  label_url            text,                               -- bucket Supabase ou URL do MKT
  printed_at           timestamptz,
  printed_by           uuid REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipment_labels_forder
  ON public.shipment_labels(fulfillment_order_id);
CREATE INDEX IF NOT EXISTS idx_shipment_labels_org
  ON public.shipment_labels(organization_id, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════
-- TRIGGERS — updated_at + promoção automática pick → pack
-- ════════════════════════════════════════════════════════════════════════

-- Touch genérico de updated_at (namespaced pro módulo)
CREATE OR REPLACE FUNCTION public.tg_fulfillment_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_warehouses_touch ON public.warehouses;
CREATE TRIGGER trg_warehouses_touch BEFORE UPDATE ON public.warehouses
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

DROP TRIGGER IF EXISTS trg_fulfillment_settings_touch ON public.fulfillment_settings;
CREATE TRIGGER trg_fulfillment_settings_touch BEFORE UPDATE ON public.fulfillment_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

DROP TRIGGER IF EXISTS trg_fulfillment_orders_touch ON public.fulfillment_orders;
CREATE TRIGGER trg_fulfillment_orders_touch BEFORE UPDATE ON public.fulfillment_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

DROP TRIGGER IF EXISTS trg_pick_tasks_touch ON public.pick_tasks;
CREATE TRIGGER trg_pick_tasks_touch BEFORE UPDATE ON public.pick_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

DROP TRIGGER IF EXISTS trg_pack_tasks_touch ON public.pack_tasks;
CREATE TRIGGER trg_pack_tasks_touch BEFORE UPDATE ON public.pack_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

-- Quando TODAS as pick_tasks de um pedido viram 'picked' (ignorando canceladas):
--   • pack_task awaiting_pick → ready_to_pack
--   • fulfillment_order received/picking → packing
CREATE OR REPLACE FUNCTION public.fn_fulfillment_promote_pack()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pick_tasks
    WHERE fulfillment_order_id = NEW.fulfillment_order_id
      AND status NOT IN ('picked','cancelled')
  ) THEN
    UPDATE public.pack_tasks
      SET status = 'ready_to_pack'
      WHERE fulfillment_order_id = NEW.fulfillment_order_id
        AND status = 'awaiting_pick';
    UPDATE public.fulfillment_orders
      SET status = 'packing'
      WHERE id = NEW.fulfillment_order_id
        AND status IN ('received','picking');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fulfillment_promote_pack ON public.pick_tasks;
CREATE TRIGGER trg_fulfillment_promote_pack
  AFTER UPDATE ON public.pick_tasks
  FOR EACH ROW WHEN (NEW.status = 'picked')
  EXECUTE FUNCTION public.fn_fulfillment_promote_pack();


-- ════════════════════════════════════════════════════════════════════════
-- RLS + GRANTS — multi-tenant (padrão pós-correção de vazamento 20260626)
--   • org-scoped: organization_id IN (SELECT get_user_org_ids())
--   • service_role: ALL true (backend usa service_role e filtra no código)
--   • GRANTs explícitos (criação via _admin_exec_sql não herda privileges)
-- Loop idempotente sobre as 9 tabelas (todas têm organization_id).
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  t    text;
  tbls text[] := ARRAY[
    'warehouses','warehouse_operators','fulfillment_settings','fulfillment_orders',
    'pick_tasks','pack_tasks','operator_actions','damage_reports','shipment_labels'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- policy org-scoped (frontend autenticado vê/escreve só a própria org)
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO public '
      || 'USING (organization_id IN (SELECT get_user_org_ids())) '
      || 'WITH CHECK (organization_id IN (SELECT get_user_org_ids()))',
      t || '_org_all', t
    );

    -- policy service_role (backend faz tudo)
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_srv', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t || '_srv', t
    );

    -- grants base
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
  END LOOP;
END $$;


-- ════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ════════════════════════════════════════════════════════════════════════
COMMENT ON TABLE public.fulfillment_orders IS
  'Pedido UNIFICADO a separar. Abstrai a origem (marketplace/storefront/b2b) — pick/pack/etiqueta operam sobre esta camada, não sobre orders direto.';
COMMENT ON TABLE public.fulfillment_settings IS
  'Config de fulfillment por org. Toggles de IA (avaria/conferência/fila) OFF por padrão — opt-in.';
COMMENT ON TABLE public.operator_actions IS
  'Log auditável de TODA ação de operador (bipagem, foto, conclusão, bloqueio, mismatch).';
