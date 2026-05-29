-- F18 F2.5 — Attribution Analytics: conversões de afiliado pending→confirmed.
--
-- Atribuição Shopee = cookie 7 dias. Estado dual:
--   pending   → clique virou conversão (ainda não confirmada)
--   confirmed → pós-entrega + pagamento (comissão liberada)
--   cancelled → devolução/cancelamento (comissão perdida)
--
-- Worker de reconciliação (Sprint 2) flipa pending→confirmed/cancelled
-- via poll /reports/conversions da Affiliate API.
--
-- ⚠️ Sem BEGIN/COMMIT — RPC _admin_exec_sql rejeita transaction commands.

CREATE TABLE IF NOT EXISTS shopee.affiliate_conversions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  sub_id             text,                          -- atribuição por canal (F2.4)
  item_id            bigint,
  channel            text NOT NULL DEFAULT 'unknown',

  order_value_cents  bigint,                         -- GMV da conversão
  commission_cents   bigint NOT NULL DEFAULT 0,

  state              text NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'confirmed', 'cancelled')),

  clicked_at         timestamptz,
  converted_at       timestamptz,
  confirmed_at       timestamptz,

  external_conversion_id text,                        -- ID na Affiliate API (dedup)
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT affiliate_conv_commission_nonneg CHECK (commission_cents >= 0)
);

-- Dedup por conversão externa (webhook reentregue não duplica)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliate_conv_external
  ON shopee.affiliate_conversions (organization_id, external_conversion_id)
  WHERE external_conversion_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_affiliate_conv_org_state
  ON shopee.affiliate_conversions (organization_id, state, converted_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_conv_org_channel
  ON shopee.affiliate_conversions (organization_id, channel, state);

CREATE INDEX IF NOT EXISTS idx_affiliate_conv_org_subid
  ON shopee.affiliate_conversions (organization_id, sub_id)
  WHERE sub_id IS NOT NULL;

-- Reconciliação: pendentes mais velhas (worker varre)
CREATE INDEX IF NOT EXISTS idx_affiliate_conv_pending_age
  ON shopee.affiliate_conversions (converted_at)
  WHERE state = 'pending';

COMMENT ON TABLE shopee.affiliate_conversions IS
  'F18 F2.5 — Conversões de afiliado. Estado pending→confirmed (pós-entrega) | cancelled (devolução). Atribuição cookie 7d por sub_id/canal.';

-- Trigger updated_at
CREATE OR REPLACE FUNCTION shopee.tg_affiliate_conv_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_affiliate_conv_touch ON shopee.affiliate_conversions;
CREATE TRIGGER trg_affiliate_conv_touch
  BEFORE UPDATE ON shopee.affiliate_conversions
  FOR EACH ROW EXECUTE FUNCTION shopee.tg_affiliate_conv_touch();

-- ── RLS + grants ────────────────────────────────────────────────────
ALTER TABLE shopee.affiliate_conversions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members affiliate_conv" ON shopee.affiliate_conversions;
CREATE POLICY "org members affiliate_conv"
  ON shopee.affiliate_conversions FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

GRANT ALL    ON TABLE shopee.affiliate_conversions TO service_role;
GRANT SELECT ON TABLE shopee.affiliate_conversions TO authenticated;

-- ── Seed demo (org Shopee Review Demo) ──────────────────────────────
-- Mostra os 3 estados + distribuição por canal.
DO $$
DECLARE
  v_demo_org uuid;
BEGIN
  SELECT id INTO v_demo_org FROM public.organizations WHERE slug = 'shopee-review-demo';
  IF v_demo_org IS NULL THEN
    RAISE NOTICE 'org shopee-review-demo ausente — pulando seed conversões';
    RETURN;
  END IF;

  DELETE FROM shopee.affiliate_conversions WHERE organization_id = v_demo_org;

  INSERT INTO shopee.affiliate_conversions
    (organization_id, sub_id, item_id, channel, order_value_cents, commission_cents, state,
     clicked_at, converted_at, confirmed_at)
  VALUES
    -- WhatsApp: forte, maioria confirmada
    (v_demo_org, 'demo_whatsapp_a', 2001, 'whatsapp',  9990, 1199, 'confirmed', now()-interval '12 days', now()-interval '11 days', now()-interval '4 days'),
    (v_demo_org, 'demo_whatsapp_b', 2001, 'whatsapp',  9990, 1199, 'confirmed', now()-interval '10 days', now()-interval '9 days',  now()-interval '2 days'),
    (v_demo_org, 'demo_whatsapp_c', 2002, 'whatsapp', 18790, 3382, 'pending',   now()-interval '3 days',  now()-interval '2 days',  NULL),
    -- Instagram: misto
    (v_demo_org, 'demo_instagram_a', 2001, 'instagram', 9990, 1199, 'confirmed', now()-interval '9 days', now()-interval '8 days', now()-interval '1 day'),
    (v_demo_org, 'demo_instagram_b', 2004, 'instagram', 7900,  395, 'cancelled', now()-interval '8 days', now()-interval '7 days', NULL),
    (v_demo_org, 'demo_instagram_c', 2002, 'instagram',18790, 3382, 'pending',   now()-interval '2 days', now()-interval '1 day',  NULL),
    -- TikTok: pendente recente
    (v_demo_org, 'demo_tiktok_a', 2001, 'tiktok', 9990, 1199, 'pending', now()-interval '1 day', now()-interval '6 hours', NULL),
    -- Shopee Video: confirmada
    (v_demo_org, 'demo_svideo_a', 2002, 'shopee_video', 18790, 3382, 'confirmed', now()-interval '15 days', now()-interval '14 days', now()-interval '6 days');
END $$;

-- ── Roadmap → F2.5 wip ──────────────────────────────────────────────
DO $$
DECLARE
  vazzo_org  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id FROM public.roadmap_phases
   WHERE organization_id = vazzo_org AND num = 'F18';
  IF v_phase_id IS NOT NULL THEN
    UPDATE public.roadmap_items
       SET status = 'wip', updated_at = now()
     WHERE phase_id = v_phase_id AND label LIKE 'F2.5 —%';
  END IF;
END $$;
