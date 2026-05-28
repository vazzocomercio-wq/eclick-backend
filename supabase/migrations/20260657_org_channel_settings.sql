-- 20260657_org_channel_settings.sql
-- Config de custos por canal (org × canal): comissão %, taxa fixa, etc.
-- Genérica e extensível pros canais futuros (Shopee, Amazon, Magalu).
-- Backend-only (service_role) — frontend lê/escreve via endpoint do backend.

CREATE TABLE IF NOT EXISTS public.org_channel_settings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  channel           text NOT NULL CHECK (channel IN (
    'mercadolivre','shopee','amazon','magalu','tiktok_shop','storefront'
  )),
  -- Comissão da plataforma em % (0-100). Pro TikTok é o que entra no platform_fee
  -- estimado no pedido (a API não devolve a comissão no order — só em Settlement).
  commission_pct    numeric NOT NULL DEFAULT 0,
  -- Taxa fixa em R$ por venda (alguns canais cobram um valor fixo + %).
  commission_fixed  numeric NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_org_channel_settings_org_channel
  ON public.org_channel_settings (organization_id, channel);

ALTER TABLE public.org_channel_settings ENABLE ROW LEVEL SECURITY;

-- Backend (service_role) escreve e lê. Frontend acessa via endpoint do backend
-- (sem policies de authenticated por enquanto — superfície menor, mais seguro).
GRANT ALL ON TABLE public.org_channel_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.org_channel_settings TO authenticated;

-- Seed inicial: comissão TikTok padrão 8% pra orgs que já têm TikTok conectado.
-- Idempotente (ON CONFLICT preserva valor manual editado).
INSERT INTO public.org_channel_settings (organization_id, channel, commission_pct)
SELECT organization_id, 'tiktok_shop', 8
FROM public.tiktok_shop_credentials
ON CONFLICT (organization_id, channel) DO NOTHING;
