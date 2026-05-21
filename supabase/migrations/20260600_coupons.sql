-- Store Builder v3 — Cupons (Fase D.1).
--
-- Tabela de cupons da loja. Cada org tem sua propria lista isolada.
-- Tipos suportados:
--  - percentage  → desconto % no subtotal (value = 1..100)
--  - fixed       → desconto fixo R$ no subtotal (value em centavos)
--  - free_shipping → frete gratis (value ignorado)
--
-- min_order_cents: pedido minimo pra valer o cupom (em centavos).
-- usage_limit: NULL = ilimitado. used_count atualizado quando o pedido e pago.
-- expires_at: NULL = sem expiracao.

CREATE TABLE IF NOT EXISTS public.coupons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code              text NOT NULL,
  type              text NOT NULL CHECK (type IN ('percentage', 'fixed', 'free_shipping')),
  value             integer NOT NULL DEFAULT 0,
  min_order_cents   integer NOT NULL DEFAULT 0,
  usage_limit       integer,
  used_count        integer NOT NULL DEFAULT 0,
  expires_at        timestamptz,
  active            boolean NOT NULL DEFAULT true,
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Codigo unico por org (case-insensitive — usuario digita "VAZZO10" ou "vazzo10").
CREATE UNIQUE INDEX IF NOT EXISTS coupons_org_code_uniq
  ON public.coupons (organization_id, lower(code));

CREATE INDEX IF NOT EXISTS coupons_org_active_idx
  ON public.coupons (organization_id, active);

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coupons_select_own ON public.coupons;
CREATE POLICY coupons_select_own ON public.coupons FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS coupons_modify_own ON public.coupons;
CREATE POLICY coupons_modify_own ON public.coupons FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

-- GRANTs (tabela criada via _admin_exec_sql nao herda defaults — bug J da skill).
GRANT ALL ON TABLE public.coupons TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.coupons TO authenticated;

-- Adiciona coupon_code + coupon_discount_cents em storefront_orders pra rastrear.
ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS coupon_code text,
  ADD COLUMN IF NOT EXISTS coupon_discount_cents integer NOT NULL DEFAULT 0;

COMMENT ON TABLE  public.coupons IS 'Cupons de desconto da loja (1 lista por org).';
COMMENT ON COLUMN public.coupons.type IS 'percentage (value=1..100) | fixed (value em centavos) | free_shipping';
