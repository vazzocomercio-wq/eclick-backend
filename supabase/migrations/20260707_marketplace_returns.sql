-- 20260707 — Devoluções/reembolsos de marketplace (Shopee returns API).
-- Tabela agnóstica de plataforma (platform discrimina; Shopee é a 1ª).
-- A ingestão também enxerta um resumo em orders.raw_data->mediations pro
-- pedido aparecer na aba "Mediação" da tela central (paridade com ML).

CREATE TABLE IF NOT EXISTS public.marketplace_returns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id),
  platform         text NOT NULL DEFAULT 'shopee',
  shop_id          text,                      -- loja (channel_account_id)
  return_sn        text NOT NULL,             -- id da devolução na plataforma
  order_sn         text,                      -- pedido externo (orders.external_order_id)
  status           text,                      -- REQUESTED/PROCESSING/ACCEPTED/JUDGING/REFUND_PAID/CLOSED/CANCELLED/SELLER_DISPUTE
  reason           text,                      -- código (WRONG_ITEM, NOT_RECEIPT, ...)
  text_reason      text,                      -- texto livre do comprador
  refund_amount    numeric,
  currency         text,
  needs_logistics  boolean,
  tracking_number  text,
  buyer_username   text,
  due_date         timestamptz,               -- prazo de resposta do seller
  return_create_at timestamptz,               -- create_time da plataforma
  return_update_at timestamptz,               -- update_time da plataforma
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform, return_sn)
);

CREATE INDEX IF NOT EXISTS idx_mp_returns_org_status
  ON public.marketplace_returns (organization_id, platform, status);
CREATE INDEX IF NOT EXISTS idx_mp_returns_org_order
  ON public.marketplace_returns (organization_id, order_sn);
CREATE INDEX IF NOT EXISTS idx_mp_returns_org_update
  ON public.marketplace_returns (organization_id, return_update_at DESC);

-- GRANTs explícitos: tabela criada via _admin_exec_sql NÃO herda os default
-- privileges do Supabase (sem isso até service_role bate em permission denied).
GRANT ALL ON TABLE public.marketplace_returns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketplace_returns TO authenticated;

ALTER TABLE public.marketplace_returns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mp_returns_org_isolation ON public.marketplace_returns;
CREATE POLICY mp_returns_org_isolation ON public.marketplace_returns
  FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members
    WHERE user_id = auth.uid()
  ));
