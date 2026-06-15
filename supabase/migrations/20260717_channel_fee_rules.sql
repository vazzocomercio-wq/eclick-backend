-- 20260717_channel_fee_rules.sql
-- Regras de take rate ESTIMADO por faixa de ticket / categoria (org × canal).
-- Motivo: o take rate achatado de org_channel_settings (ex.: Shopee 33,06%) é uma
-- MÉDIA da carteira; o take real varia muito por faixa de preço (auditoria escrow
-- jun/2026: <R$50 = 38,4% … >R$300 = 28,8%). Um % único superestima a margem de
-- item barato e subestima a de item caro. Esta tabela permite estimar por faixa;
-- quando não há regra que case, cai no take achatado de org_channel_settings.

CREATE TABLE IF NOT EXISTS public.channel_fee_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  channel                 text NOT NULL CHECK (channel IN (
    'mercadolivre','shopee','amazon','magalu','tiktok_shop','storefront'
  )),
  -- null = qualquer categoria (regra genérica do canal)
  category_id             text,
  -- faixa de ticket [min_price, max_price): null = sem piso / sem teto
  min_price               numeric,
  max_price               numeric,
  estimated_take_rate_pct numeric NOT NULL CHECK (estimated_take_rate_pct >= 0 AND estimated_take_rate_pct <= 100),
  fixed_fee               numeric NOT NULL DEFAULT 0,
  -- vigência (permite reajuste versionado, igual marketplace_shipping_rates)
  effective_from          date NOT NULL DEFAULT current_date,
  effective_to            date,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_channel_fee_rules_lookup
  ON public.channel_fee_rules (organization_id, channel, effective_from);

ALTER TABLE public.channel_fee_rules ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.channel_fee_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_fee_rules TO authenticated;

-- Seed Vazzo (org 4ef1aabd…) — take real por faixa da auditoria de escrow Shopee
-- jun/2026. Guard idempotente: só insere se a org ainda não tem regras Shopee.
DO $$
DECLARE vazzo uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
BEGIN
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = vazzo)
     AND NOT EXISTS (SELECT 1 FROM public.channel_fee_rules WHERE organization_id = vazzo AND channel = 'shopee') THEN
    INSERT INTO public.channel_fee_rules
      (organization_id, channel, min_price, max_price, estimated_take_rate_pct, effective_from, notes)
    VALUES
      (vazzo, 'shopee', 0,    50,   38.4, DATE '2026-06-01', 'Auditoria escrow jun/2026 — faixa <R$50'),
      (vazzo, 'shopee', 50,   150,  33.0, DATE '2026-06-01', 'Auditoria escrow jun/2026 — faixa R$50-150'),
      (vazzo, 'shopee', 150,  300,  29.8, DATE '2026-06-01', 'Auditoria escrow jun/2026 — faixa R$150-300'),
      (vazzo, 'shopee', 300,  NULL, 28.8, DATE '2026-06-01', 'Auditoria escrow jun/2026 — faixa >R$300');
  END IF;
END $$;
