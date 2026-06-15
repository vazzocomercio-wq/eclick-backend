-- 20260718_channel_take_reconciliation.sql
-- Reconciliação mensal: take ESTIMADO (configurado) × take REAL observado no
-- escrow/fatura (platform_charges). Mantém o take configurado honesto — se
-- descolar do real > 2 pts, a linha vem `flagged` pra recalibrar.

CREATE TABLE IF NOT EXISTS public.channel_take_reconciliation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  channel              text NOT NULL,
  period_key           text NOT NULL,                       -- YYYY-MM (mês civil)
  revenue              numeric NOT NULL DEFAULT 0,
  fees                 numeric NOT NULL DEFAULT 0,           -- taxas reais (exceto ads)
  observed_take_pct    numeric,                              -- fees / revenue * 100
  configured_take_pct  numeric,                              -- org_channel_settings
  diff_pct             numeric,                              -- observed − configured
  flagged              boolean NOT NULL DEFAULT false,       -- |diff| > 2 pts
  by_bucket            jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- take real por faixa de ticket
  computed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_take_reconciliation
  ON public.channel_take_reconciliation (organization_id, channel, period_key);

ALTER TABLE public.channel_take_reconciliation ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.channel_take_reconciliation TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_take_reconciliation TO authenticated;
