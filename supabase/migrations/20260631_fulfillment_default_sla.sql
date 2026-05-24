-- F12 Fulfillment Sprint 4 — SLA configurável.
--
-- Prazo de despacho padrão (horas a partir da criação do pedido). O seed
-- preenche fulfillment_orders.sla_deadline + pick_tasks.sla_deadline com base
-- nisso, e o dashboard/fila destacam os ATRASADOS.

ALTER TABLE public.fulfillment_settings
  ADD COLUMN IF NOT EXISTS default_sla_hours integer NOT NULL DEFAULT 24;

COMMENT ON COLUMN public.fulfillment_settings.default_sla_hours IS
  'Prazo de despacho padrão (horas) a partir da criação. Preenche sla_deadline no seed; pedidos vencidos = atrasados.';
