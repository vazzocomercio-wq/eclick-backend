-- 20260721_fulfillment_locations.sql
-- Endereçamento de estoque (WMS slotting) — Fase 1 (MVP "onde está").
-- Dá endereço físico (Rua-Estante-Nível-Posição) aos produtos no CD pra a lista de
-- coleta (individual e em ondas) dizer ONDE pegar e ordenar a coleta como ROTA.
--   • warehouse_locations = os endereços do CD (etiqueta bipável + ordem de caminhada).
--   • product_locations    = qual produto fica em qual endereço (endereço principal).
--   • pick_tasks (+3 cols)  = endereço gravado na ingestão (denormalizado: exibir + ordenar sem join).
-- NÃO controla quantidade por posição (isso é melhoria futura — estoque por endereço).

-- ── Endereços do CD ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.warehouse_locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  warehouse_id    uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  code            text NOT NULL,                 -- etiqueta bipável, ex.: R02-E05-N3-P01
  rua             int,
  estante         int,
  nivel           int,
  posicao         int,
  sequence        bigint NOT NULL DEFAULT 0,     -- ordem de caminhada (a ROTA)
  location_type   text NOT NULL DEFAULT 'picking'
                  CHECK (location_type IN ('picking','pulmao','staging','devolucao')),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, warehouse_id, code)
);
CREATE INDEX IF NOT EXISTS ix_warehouse_locations_route
  ON public.warehouse_locations (organization_id, warehouse_id, sequence);

-- ── Vínculo produto ↔ endereço (slotting) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES public.warehouse_locations(id) ON DELETE CASCADE,
  is_primary      boolean NOT NULL DEFAULT true, -- endereço principal de coleta
  source          text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','import','capture','abc')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, product_id, location_id)
);
CREATE INDEX IF NOT EXISTS ix_product_locations_product
  ON public.product_locations (organization_id, product_id);
CREATE INDEX IF NOT EXISTS ix_product_locations_location
  ON public.product_locations (organization_id, location_id);

-- ── Endereço gravado no pedido (denormalizado p/ exibir + ordenar a coleta) ───
ALTER TABLE public.pick_tasks ADD COLUMN IF NOT EXISTS location_id   uuid REFERENCES public.warehouse_locations(id) ON DELETE SET NULL;
ALTER TABLE public.pick_tasks ADD COLUMN IF NOT EXISTS location_code text;
ALTER TABLE public.pick_tasks ADD COLUMN IF NOT EXISTS location_seq  bigint;

-- ── RLS + GRANTs (acesso pelo backend via service_role; padrão do repo) ───────
ALTER TABLE public.warehouse_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_locations   ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.warehouse_locations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.warehouse_locations TO authenticated;
GRANT ALL ON TABLE public.product_locations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_locations TO authenticated;
