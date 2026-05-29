-- F18 F2.1+F2.3 — Lado Afiliado: connections + offers + Opportunity Score seed.
--
-- Módulo SEPARADO do marketplace vendedor (T2). Affiliate API
-- (affiliate.shopee.com.br) tem App ID/Secret próprios — aprovação manual
-- separada (W.7, ainda não iniciada). app_secret encriptado quando vier.
--
-- ⚠️ Sem BEGIN/COMMIT — RPC _admin_exec_sql rejeita transaction commands.

-- ── 1. affiliate_connections ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopee.affiliate_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  app_id            text,
  app_secret_enc    text,                          -- AES (MARKETPLACE_CONFIG_KEY) — setado no connect
  affiliate_id      text,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'expired', 'revoked')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 1 conexão Affiliate por org (T2 — afiliado é por org)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliate_conn_org
  ON shopee.affiliate_connections (organization_id);

COMMENT ON TABLE shopee.affiliate_connections IS
  'F18 F2.1 — Conexão Shopee Affiliate API por org (app_id/secret próprios, distinto do Open Platform vendedor).';

-- ── 2. affiliate_offers ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopee.affiliate_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id           bigint NOT NULL,
  shop_id           bigint,
  name              text,
  category          text,
  price_cents       bigint,

  commission_rate   numeric(5,4) NOT NULL,         -- 0-1 (0.1234 = 12.34%)
  rating            numeric(3,2),                  -- 0-5
  sales_volume      integer,
  seller_score      smallint,                      -- 0-100
  trend_score       smallint,                      -- 0-100 (do Radar)

  -- Opportunity Score computado (snapshot; service recalcula on-read pro breakdown)
  opportunity_score smallint NOT NULL DEFAULT 0,
  conv_estimate     numeric(4,3),

  raw               jsonb,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT affiliate_offers_commission_range CHECK (commission_rate BETWEEN 0 AND 1),
  CONSTRAINT affiliate_offers_rating_range     CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  CONSTRAINT affiliate_offers_opp_range        CHECK (opportunity_score BETWEEN 0 AND 100)
);

-- 1 oferta por (org, item) — upsert no ingestion
CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliate_offers_org_item
  ON shopee.affiliate_offers (organization_id, item_id);

-- Discovery: ranking por opportunity_score desc
CREATE INDEX IF NOT EXISTS idx_affiliate_offers_org_opp
  ON shopee.affiliate_offers (organization_id, opportunity_score DESC, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_offers_org_cat
  ON shopee.affiliate_offers (organization_id, category, opportunity_score DESC);

COMMENT ON TABLE shopee.affiliate_offers IS
  'F18 F2.3 — Ofertas de afiliado com Opportunity Score (comissão×conversão×reputação×trend). Filtro de saída: rating<4.5 / seller fraco = excluded.';

-- ── 3. RLS + grants ─────────────────────────────────────────────────
ALTER TABLE shopee.affiliate_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopee.affiliate_offers      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members affiliate_conn" ON shopee.affiliate_connections;
CREATE POLICY "org members affiliate_conn"
  ON shopee.affiliate_connections FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "org members affiliate_offers" ON shopee.affiliate_offers;
CREATE POLICY "org members affiliate_offers"
  ON shopee.affiliate_offers FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

GRANT ALL    ON TABLE shopee.affiliate_connections TO service_role;
GRANT SELECT ON TABLE shopee.affiliate_connections TO authenticated;
GRANT ALL    ON TABLE shopee.affiliate_offers      TO service_role;
GRANT SELECT ON TABLE shopee.affiliate_offers      TO authenticated;

-- ── 4. Seed demo (org Shopee Review Demo) ───────────────────────────
-- 5 ofertas mostrando o ranking inteligente: comissão alta MAS nota baixa
-- afunda; comissão média com alta conversão+reputação sobe.
DO $$
DECLARE
  v_demo_org uuid;
BEGIN
  SELECT id INTO v_demo_org FROM public.organizations WHERE slug = 'shopee-review-demo';
  IF v_demo_org IS NULL THEN
    RAISE NOTICE 'org shopee-review-demo ausente — pulando seed afiliado';
    RETURN;
  END IF;

  DELETE FROM shopee.affiliate_offers WHERE organization_id = v_demo_org;

  INSERT INTO shopee.affiliate_offers
    (organization_id, item_id, shop_id, name, category, price_cents,
     commission_rate, rating, sales_volume, seller_score, trend_score,
     opportunity_score, conv_estimate)
  VALUES
    -- WINNER: comissão média (12%) mas conversão+reputação+trend altíssimos
    (v_demo_org, 2001, 999990003, 'Arandela LED Cristal K9 Dourada Premium', 'Arandelas', 9990,
     0.12, 4.9, 1240, 92, 87,  91, 0.078),
    -- BOM: comissão alta (18%) + bons sinais
    (v_demo_org, 2002, 999990004, 'Lustre Pendente Vidro Soprado Âmbar', 'Lustres', 18790,
     0.18, 4.7, 430, 85, 72,   85, 0.066),
    -- ARMADILHA: comissão altíssima (25%) MAS nota 4.1 → EXCLUÍDA (devolução cancela)
    (v_demo_org, 2003, 999990005, 'Kit 10 Spots LED Genérico', 'Spots de Embutir', 4500,
     0.25, 4.1, 89, 55, 45,    0, 0.044),
    -- MÉDIO: comissão baixa (5%) mas produto sólido
    (v_demo_org, 2004, 999990003, 'Trilho Eletrificado 1m Preto', 'Trilhos', 7900,
     0.05, 4.8, 670, 88, 60,   64, 0.072),
    -- ARMADILHA 2: comissão alta (20%) MAS vendedor fraco (score 30) → EXCLUÍDA
    (v_demo_org, 2005, 999990006, 'Fita LED RGB 5m Importada', 'Iluminação LED', 3200,
     0.20, 4.6, 210, 30, 80,   0, 0.062);
END $$;

-- ── 5. Roadmap → F2.1 + F2.3 wip ────────────────────────────────────
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
     WHERE phase_id = v_phase_id
       AND (label LIKE 'F2.1 —%' OR label LIKE 'F2.3 —%');
  END IF;
END $$;
