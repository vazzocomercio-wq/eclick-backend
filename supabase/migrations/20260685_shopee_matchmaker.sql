-- F18 F4.1 — A Ponte (Matchmaker): affiliate_profiles + match_offers.
--
-- Diretório de afiliados opt-in (Consent gate F4.3 marca status='active').
-- Vendedor rankeia por Match Score (nicho×alcance×canal×histórico) e
-- propõe comissão; afiliado aceita/recusa. Ciclo medido em conversions.
--
-- ⚠️ Sem BEGIN/COMMIT — RPC _admin_exec_sql rejeita transaction commands.

-- ── 1. affiliate_profiles (diretório) ───────────────────────────────
CREATE TABLE IF NOT EXISTS shopee.affiliate_profiles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- org_id NULL = afiliado da plataforma (visível a todos vendedores);
  -- preenchido = afiliado vinculado a uma org específica.
  organization_id      uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  display_name         text NOT NULL,
  niches               text[] NOT NULL DEFAULT '{}',
  channels             text[] NOT NULL DEFAULT '{}',
  reach_estimate       integer NOT NULL DEFAULT 0,
  avg_conversion_rate  numeric(4,3),
  niche_conversion     jsonb,                          -- { nicho: taxa }
  -- Consent gate F4.3: só 'active' aparece no matchmaker
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'paused', 'revoked')),
  consent_at           timestamptz,                    -- opt-in explícito (PF)
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_profiles_status
  ON shopee.affiliate_profiles (status, reach_estimate DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_profiles_niches
  ON shopee.affiliate_profiles USING gin (niches);

COMMENT ON TABLE shopee.affiliate_profiles IS
  'F18 F4.1 — Diretório de afiliados pro Matchmaker. Opt-in via Consent gate (F4.3): só status=active é matcheável.';

-- ── 2. match_offers (propostas vendedor→afiliado) ───────────────────
CREATE TABLE IF NOT EXISTS shopee.match_offers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_shop_id          bigint NOT NULL,
  item_id                 bigint NOT NULL,
  affiliate_profile_id    uuid NOT NULL REFERENCES shopee.affiliate_profiles(id) ON DELETE CASCADE,

  proposed_commission_pct numeric(5,4) NOT NULL,       -- 0-1
  match_score             smallint NOT NULL DEFAULT 0,
  match_breakdown         jsonb,

  status                  text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'accepted', 'declined', 'active', 'paused')),
  responded_at            timestamptz,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT match_offers_commission_range CHECK (proposed_commission_pct BETWEEN 0 AND 1),
  CONSTRAINT match_offers_score_range      CHECK (match_score BETWEEN 0 AND 100)
);

-- 1 proposta aberta por (org, item, afiliado) — evita spam de propostas
CREATE UNIQUE INDEX IF NOT EXISTS uniq_match_offers_open
  ON shopee.match_offers (organization_id, item_id, affiliate_profile_id)
  WHERE status IN ('open', 'accepted', 'active');

CREATE INDEX IF NOT EXISTS idx_match_offers_org_status
  ON shopee.match_offers (organization_id, status, match_score DESC);

COMMENT ON TABLE shopee.match_offers IS
  'F18 F4.1 — Propostas de match vendedor→afiliado com Match Score snapshot. Ciclo: open→accepted→active.';

-- View com nome do afiliado (pra UI)
CREATE OR REPLACE VIEW shopee.v_match_offers AS
SELECT
  m.id, m.organization_id, m.seller_shop_id, m.item_id,
  m.affiliate_profile_id, p.display_name AS affiliate_name,
  m.proposed_commission_pct, m.match_score, m.match_breakdown,
  m.status, m.created_at, m.responded_at
FROM shopee.match_offers m
LEFT JOIN shopee.affiliate_profiles p ON p.id = m.affiliate_profile_id;

COMMENT ON VIEW shopee.v_match_offers IS 'F18 F4.1 — match_offers + nome do afiliado.';

-- ── 3. Trigger updated_at ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION shopee.tg_matchmaker_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_affiliate_profiles_touch ON shopee.affiliate_profiles;
CREATE TRIGGER trg_affiliate_profiles_touch
  BEFORE UPDATE ON shopee.affiliate_profiles
  FOR EACH ROW EXECUTE FUNCTION shopee.tg_matchmaker_touch();

DROP TRIGGER IF EXISTS trg_match_offers_touch ON shopee.match_offers;
CREATE TRIGGER trg_match_offers_touch
  BEFORE UPDATE ON shopee.match_offers
  FOR EACH ROW EXECUTE FUNCTION shopee.tg_matchmaker_touch();

-- ── 4. RLS + grants ─────────────────────────────────────────────────
ALTER TABLE shopee.affiliate_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopee.match_offers       ENABLE ROW LEVEL SECURITY;

-- Profiles: afiliados de plataforma (org_id null, active) visíveis a todos
-- members autenticados; profiles de org só pra própria org.
DROP POLICY IF EXISTS "affiliate_profiles read" ON shopee.affiliate_profiles;
CREATE POLICY "affiliate_profiles read"
  ON shopee.affiliate_profiles FOR SELECT
  USING (
    (organization_id IS NULL AND status = 'active')
    OR organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "match_offers read" ON shopee.match_offers;
CREATE POLICY "match_offers read"
  ON shopee.match_offers FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

GRANT ALL    ON TABLE shopee.affiliate_profiles TO service_role;
GRANT SELECT ON TABLE shopee.affiliate_profiles TO authenticated;
GRANT ALL    ON TABLE shopee.match_offers       TO service_role;
GRANT SELECT ON TABLE shopee.match_offers       TO authenticated;
GRANT SELECT ON shopee.v_match_offers           TO authenticated, service_role;

-- ── 5. Seed demo: diretório de afiliados (plataforma) + 1 proposta ──
DO $$
DECLARE
  v_demo_org uuid;
  v_aff1 uuid; v_aff2 uuid; v_aff3 uuid;
BEGIN
  SELECT id INTO v_demo_org FROM public.organizations WHERE slug = 'shopee-review-demo';

  -- Afiliados de PLATAFORMA (org_id null) — visíveis a todos, opt-in active
  DELETE FROM shopee.affiliate_profiles WHERE display_name LIKE 'DEMO %';

  INSERT INTO shopee.affiliate_profiles
    (organization_id, display_name, niches, channels, reach_estimate, avg_conversion_rate, niche_conversion, status, consent_at)
  VALUES
    (NULL, 'DEMO Ju Decora', ARRAY['iluminacao','decoracao','casa'], ARRAY['instagram','tiktok','shopee_video'], 87000, 0.071,
      '{"iluminacao":0.085,"decoracao":0.062}'::jsonb, 'active', now()),
    (NULL, 'DEMO Casa & Luz', ARRAY['iluminacao','eletrica'], ARRAY['whatsapp','blog'], 12000, 0.044,
      '{"iluminacao":0.051}'::jsonb, 'active', now()),
    (NULL, 'DEMO Tech Reviews BR', ARRAY['eletronicos','gadgets'], ARRAY['tiktok','shopee_live'], 210000, 0.038,
      '{"eletronicos":0.041}'::jsonb, 'active', now())
  RETURNING id INTO v_aff1;

  -- Pega os ids dos 3 demo
  SELECT id INTO v_aff1 FROM shopee.affiliate_profiles WHERE display_name = 'DEMO Ju Decora';
  SELECT id INTO v_aff2 FROM shopee.affiliate_profiles WHERE display_name = 'DEMO Casa & Luz';

  -- 1 proposta demo (Vazzo→Ju Decora pra Arandela K9, comissão 12%)
  IF v_demo_org IS NOT NULL AND v_aff1 IS NOT NULL THEN
    DELETE FROM shopee.match_offers WHERE organization_id = v_demo_org AND item_id = 1001;
    INSERT INTO shopee.match_offers
      (organization_id, seller_shop_id, item_id, affiliate_profile_id,
       proposed_commission_pct, match_score, match_breakdown, status)
    VALUES
      (v_demo_org, 999990001, 1001, v_aff1, 0.12, 91,
       '{"score":91,"components":{"niche_fit":100,"reach":71,"channel_fit":100,"history":100},"reasons":["Afiliado cobre exatamente o nicho \"iluminacao\".","Canais compatíveis: instagram, tiktok, shopee_video.","Conversão histórica forte (8.5%)."]}'::jsonb,
       'open');
  END IF;
END $$;

-- ── 6. Roadmap → F4.1 wip ───────────────────────────────────────────
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
     WHERE phase_id = v_phase_id AND label LIKE 'F4.1 —%';
  END IF;
END $$;
