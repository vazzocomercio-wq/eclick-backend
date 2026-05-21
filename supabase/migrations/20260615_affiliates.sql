-- Programa de Afiliados pra Loja Própria.
--
-- Inspirado em Shopee Affiliate Program (SAP), TikTok Shop Affiliates e
-- ML Programa de Afiliados:
--   - SAP: % flat por categoria, cookie 7d, dashboard com cliques/vendas
--   - TikTok: open vs targeted, criadores convidados
--   - ML: cookie 30d, dedup mesmo cliente, anti-fraude self-purchase
--
-- Arquitetura:
--   1. settings globais por loja (store_config.affiliate_settings JSONB)
--   2. affiliates (1 row por afiliado) — email único por org
--   3. affiliate_clicks (audit de cliques pro dashboard de stats)
--   4. affiliate_commissions (1 row por venda atribuída) com status
--      pending → approved (após refund window) → paid
--   5. affiliate_payouts (saques solicitados/processados)

-- ── Settings da loja (JSONB no store_config) ────────────────────────
ALTER TABLE public.store_config
  ADD COLUMN IF NOT EXISTS affiliate_settings JSONB
  DEFAULT '{
    "enabled":              false,
    "defaultCommissionPct": 5,
    "cookieDays":           30,
    "refundWindowDays":     30,
    "approvalMode":         "open",
    "minWithdrawCents":     2000,
    "allowSelfPurchase":    false
  }'::jsonb;

UPDATE public.store_config
   SET affiliate_settings = '{
     "enabled":              false,
     "defaultCommissionPct": 5,
     "cookieDays":           30,
     "refundWindowDays":     30,
     "approvalMode":         "open",
     "minWithdrawCents":     2000,
     "allowSelfPurchase":    false
   }'::jsonb
 WHERE affiliate_settings IS NULL;

COMMENT ON COLUMN public.store_config.affiliate_settings IS
  'Config global do programa de afiliados: enabled, %, cookie days, refund window, approval mode (open|invite_only), saque mínimo.';

-- ── Afiliados ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Identificação
  code                text NOT NULL,                         -- slug curto pro ?ref=X (ex: "joao_x9")
  name                text NOT NULL,
  email               text NOT NULL,
  phone               text,
  doc                 text,                                   -- CPF/CNPJ pra pagamento

  -- Auth (pode logar no painel próprio)
  password_hash       text,                                   -- mesmo PBKDF2 dos customers

  -- Override de comissão pra esse afiliado específico (VIPs)
  custom_commission_pct numeric(5, 2),                        -- NULL = usa default da loja

  -- Status
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  approved_at         timestamptz,
  rejected_reason     text,

  -- Dados pra pagamento (PIX, conta bancária — JSONB livre)
  payout_method       text,                                   -- 'pix' | 'bank_transfer'
  payout_details      jsonb,                                  -- { pix_key, bank, agency, account }

  -- Stats agregados (incrementados — denormalizados pra performance)
  total_clicks        integer NOT NULL DEFAULT 0,
  total_orders        integer NOT NULL DEFAULT 0,
  total_earned_cents  integer NOT NULL DEFAULT 0,
  total_paid_cents    integer NOT NULL DEFAULT 0,

  -- Audit
  last_login_at       timestamptz,
  last_activity_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliates_org_code
  ON public.affiliates (organization_id, lower(code));

CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliates_org_email
  ON public.affiliates (organization_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_affiliates_org_status
  ON public.affiliates (organization_id, status, created_at DESC);

COMMENT ON TABLE public.affiliates IS
  'Afiliados da loja (cadastro próprio ou convite). Identificados por código no ?ref=.';

-- ── Cliques (audit pro dashboard) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_clicks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id        uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  referrer_url        text,                                  -- de onde veio (Instagram, blog, etc)
  landing_url         text,                                  -- página da loja que abriu
  user_agent          text,
  ip_hash             text,                                  -- hash SHA-256 do IP (LGPD)
  customer_email_hash text,                                  -- se já identificado, hash do email
  customer_id         uuid REFERENCES public.storefront_customers(id) ON DELETE SET NULL,

  -- Anti-dedup window: se mesmo ip_hash + affiliate_id em 24h, NÃO conta de novo
  -- (controlado pelo service no momento do insert)

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_affiliate
  ON public.affiliate_clicks (affiliate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_org_date
  ON public.affiliate_clicks (organization_id, created_at DESC);

-- Dedup: dentro de 24h, mesmo ip_hash + affiliate_id conta 1x só
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_dedup
  ON public.affiliate_clicks (affiliate_id, ip_hash, created_at)
  WHERE ip_hash IS NOT NULL;

COMMENT ON TABLE public.affiliate_clicks IS
  'Audit de cliques nos links do afiliado. Dedup 24h por (affiliate, ip_hash).';

-- ── Comissões (1 por venda atribuída) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_commissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id        uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id            uuid NOT NULL REFERENCES public.storefront_orders(id) ON DELETE CASCADE,

  order_total_cents   integer NOT NULL,                       -- snapshot do total na hora
  commission_pct      numeric(5, 2) NOT NULL,
  amount_cents        integer NOT NULL,

  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'paid', 'rejected', 'refunded')),

  approved_at         timestamptz,                            -- quando saiu da refund window
  paid_at             timestamptz,                            -- quando lojista marcou pago
  payout_id           uuid,                                   -- FK pra affiliate_payouts (set later)

  rejected_reason     text,
  notes               text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Idempotência: 1 comissão por (affiliate, order) — webhook reentregue não duplica
CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliate_commissions_order
  ON public.affiliate_commissions (affiliate_id, order_id);

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_org_status
  ON public.affiliate_commissions (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_affiliate
  ON public.affiliate_commissions (affiliate_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_pending_approval
  ON public.affiliate_commissions (organization_id, approved_at)
  WHERE status = 'pending';

COMMENT ON TABLE public.affiliate_commissions IS
  'Comissões geradas por vendas. Status: pending → approved → paid (ou rejected/refunded).';

-- ── Payouts (saques) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_payouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id        uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  amount_cents        integer NOT NULL,
  commission_count    integer NOT NULL DEFAULT 0,             -- N comissões agregadas neste payout
  method              text NOT NULL,                          -- 'pix' | 'bank_transfer' | 'manual'
  reference           text,                                    -- comprovante / id da transferência
  notes               text,

  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),

  requested_at        timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  cancelled_at        timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_affiliate
  ON public.affiliate_payouts (affiliate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_org_status
  ON public.affiliate_payouts (organization_id, status, created_at DESC);

COMMENT ON TABLE public.affiliate_payouts IS
  'Saques solicitados pelo afiliado. Agrega N comissões approved.';

-- ── FK back-ref ────────────────────────────────────────────────────
-- payout_id em affiliate_commissions aponta pra affiliate_payouts
ALTER TABLE public.affiliate_commissions
  DROP CONSTRAINT IF EXISTS fk_affiliate_commissions_payout;
ALTER TABLE public.affiliate_commissions
  ADD CONSTRAINT fk_affiliate_commissions_payout
  FOREIGN KEY (payout_id) REFERENCES public.affiliate_payouts(id) ON DELETE SET NULL;

-- ── Storefront orders ganha affiliate_id pra rastreamento direto ───
ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS affiliate_id uuid REFERENCES public.affiliates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_storefront_orders_affiliate
  ON public.storefront_orders (affiliate_id, created_at DESC)
  WHERE affiliate_id IS NOT NULL;

-- ── Triggers updated_at ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_affiliates_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_affiliates_touch ON public.affiliates;
CREATE TRIGGER trg_affiliates_touch
  BEFORE UPDATE ON public.affiliates
  FOR EACH ROW EXECUTE FUNCTION public.tg_affiliates_touch();

DROP TRIGGER IF EXISTS trg_affiliate_commissions_touch ON public.affiliate_commissions;
CREATE TRIGGER trg_affiliate_commissions_touch
  BEFORE UPDATE ON public.affiliate_commissions
  FOR EACH ROW EXECUTE FUNCTION public.tg_affiliates_touch();

DROP TRIGGER IF EXISTS trg_affiliate_payouts_touch ON public.affiliate_payouts;
CREATE TRIGGER trg_affiliate_payouts_touch
  BEFORE UPDATE ON public.affiliate_payouts
  FOR EACH ROW EXECUTE FUNCTION public.tg_affiliates_touch();

-- ── Grants ──────────────────────────────────────────────────────────
GRANT ALL ON TABLE public.affiliates             TO service_role;
GRANT ALL ON TABLE public.affiliate_clicks       TO service_role;
GRANT ALL ON TABLE public.affiliate_commissions  TO service_role;
GRANT ALL ON TABLE public.affiliate_payouts      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliates             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_clicks       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_commissions  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.affiliate_payouts      TO authenticated;
