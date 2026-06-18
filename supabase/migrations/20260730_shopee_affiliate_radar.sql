-- F18 Sprint 2 — Radar de Produtos Campeões Shopee (ingestão real + Champion Score).
-- Affiliate Open API liberada → guarda credenciais (app_id/secret) e amplia
-- affiliate_offers com champion_score + decisão de compra + desconto + links.

-- ── 1. Credenciais da Affiliate API em affiliate_connections ────────────────
ALTER TABLE shopee.affiliate_connections
  ADD COLUMN IF NOT EXISTS app_id     text,
  ADD COLUMN IF NOT EXISTS app_secret text;   -- só service_role lê (grant abaixo)

COMMENT ON COLUMN shopee.affiliate_connections.app_secret IS
  'Secret da Affiliate Open API. NUNCA exposto ao cliente — só service_role tem SELECT.';

-- ── 2. affiliate_offers: campos do Radar de sourcing ────────────────────────
ALTER TABLE shopee.affiliate_offers
  ADD COLUMN IF NOT EXISTS champion_score numeric,
  ADD COLUMN IF NOT EXISTS buy_decision   text CHECK (buy_decision IN ('comprar','observar','ignorar')),
  ADD COLUMN IF NOT EXISTS ai_rationale   text,
  ADD COLUMN IF NOT EXISTS discount_pct   numeric,
  ADD COLUMN IF NOT EXISTS product_link   text,
  ADD COLUMN IF NOT EXISTS offer_link     text,
  ADD COLUMN IF NOT EXISTS rating_count   bigint,
  ADD COLUMN IF NOT EXISTS image_url      text,
  ADD COLUMN IF NOT EXISTS source         text DEFAULT 'product_offer';

CREATE INDEX IF NOT EXISTS idx_aff_offers_org_champion
  ON shopee.affiliate_offers (organization_id, champion_score DESC);

-- 1 oferta por (org, item) — upsert no ingest
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_offers_org_item
  ON shopee.affiliate_offers (organization_id, item_id);

-- ── 3. Série temporal por oferta (análise: vendas/preço/nota/score no tempo) ─
CREATE TABLE IF NOT EXISTS shopee.offer_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id         bigint NOT NULL,
  sales           bigint,
  price_cents     bigint,
  discount_pct    numeric,
  rating          numeric,
  commission_rate numeric,
  champion_score  numeric,
  captured_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offer_signals_org_item
  ON shopee.offer_signals (organization_id, item_id, captured_at DESC);

COMMENT ON TABLE shopee.offer_signals IS
  'Radar Shopee — histórico diário por oferta (vendas reais, preço, desconto, nota, score). Alimenta a tela de Análise.';

-- ── 4. RLS + grants ─────────────────────────────────────────────────────────
ALTER TABLE shopee.offer_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org members offer_signals read" ON shopee.offer_signals;
CREATE POLICY "org members offer_signals read" ON shopee.offer_signals FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));
GRANT ALL    ON TABLE shopee.offer_signals TO service_role;
GRANT SELECT ON TABLE shopee.offer_signals TO authenticated;

-- app_secret: revoga de authenticated (column-level) — só service_role lê
REVOKE SELECT ON shopee.affiliate_connections FROM authenticated;
GRANT  SELECT (id, organization_id, affiliate_id, status, app_id, created_at, updated_at)
  ON shopee.affiliate_connections TO authenticated;
GRANT  ALL ON shopee.affiliate_connections TO service_role;

-- ── 5. Conexão Affiliate da org ─────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_aff_conn_org ON shopee.affiliate_connections (organization_id);

-- As credenciais reais (app_id/app_secret) NÃO ficam no repo. São inseridas
-- fora do git, via script seguro com _admin_exec_sql substituindo placeholders
-- (__APP_ID__/__SECRET__), por org. Aplicado p/ Vazzo em 2026-06-18.
-- INSERT INTO shopee.affiliate_connections (organization_id, affiliate_id, status, app_id, app_secret)
-- VALUES ('<org>', '<app_id>', 'active', '<app_id>', '<secret>')
-- ON CONFLICT (organization_id) DO UPDATE SET app_id=EXCLUDED.app_id, app_secret=EXCLUDED.app_secret, status='active';
