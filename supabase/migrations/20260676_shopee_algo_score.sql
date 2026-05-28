-- F18 F1.1 — Shopee Algorithm Score (4 pilares 40/30/20/10 + issues).
--
-- Schema `shopee.*` (T1 do roadmap): produto fica em public.products (hub
-- Estoque Unificado); shopee.* só pra scores/métricas/campanhas Shopee-
-- específicas.
--
-- Tabela algo_score_breakdown:
--   • 1 INSERT por compute (histórico). Score atual = ORDER BY computed_at
--     DESC LIMIT 1 por (org, shop, item).
--   • Pillars individuais 0-100 + total 0-100 (cravado por CHECK).
--   • issues jsonb = lista priorizada de correções acionáveis.
--   • input_snapshot jsonb = inputs usados pro debug + replay (sem PII).
--
-- Service: ShopeeAlgoScoreService.compute()/computeAndPersist() — pure
-- function pro compute (testável determinístico) + persist separado.

-- ── 1. Schema dedicado ───────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS shopee;
COMMENT ON SCHEMA shopee IS
  'Dados específicos Shopee — scores/métricas/campanhas. Produto vive em public.products (hub do Estoque Unificado).';

GRANT USAGE ON SCHEMA shopee TO authenticated, service_role;

-- ── 2. Tabela breakdown ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopee.algo_score_breakdown (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id          bigint NOT NULL,
  item_id          bigint NOT NULL,
  product_id       uuid REFERENCES public.products(id) ON DELETE SET NULL,

  -- Score total (0-100) + breakdown por pilar
  algo_score       smallint NOT NULL,
  relevance        smallint NOT NULL,
  performance      smallint NOT NULL,
  seller_quality   smallint NOT NULL,
  price_marketing  smallint NOT NULL,

  -- Lista priorizada de correções
  issues           jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Snapshot dos inputs (debug + replay)
  input_snapshot   jsonb,

  computed_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT algo_score_breakdown_total_range CHECK (algo_score       BETWEEN 0 AND 100),
  CONSTRAINT algo_score_breakdown_rel_range   CHECK (relevance        BETWEEN 0 AND 100),
  CONSTRAINT algo_score_breakdown_perf_range  CHECK (performance      BETWEEN 0 AND 100),
  CONSTRAINT algo_score_breakdown_qual_range  CHECK (seller_quality   BETWEEN 0 AND 100),
  CONSTRAINT algo_score_breakdown_pm_range    CHECK (price_marketing  BETWEEN 0 AND 100)
);

COMMENT ON TABLE shopee.algo_score_breakdown IS
  'F18 F1.1 — Histórico de Algorithm Score Shopee por anúncio. 1 row por compute; score atual = MAX(computed_at).';

-- Índices operacionais
CREATE INDEX IF NOT EXISTS idx_algo_score_org_shop_item_time
  ON shopee.algo_score_breakdown (organization_id, shop_id, item_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_algo_score_low_recent
  ON shopee.algo_score_breakdown (organization_id, algo_score, computed_at DESC)
  WHERE algo_score < 70;

CREATE INDEX IF NOT EXISTS idx_algo_score_product
  ON shopee.algo_score_breakdown (product_id, computed_at DESC)
  WHERE product_id IS NOT NULL;

-- ── 3. RLS ──────────────────────────────────────────────────────────
ALTER TABLE shopee.algo_score_breakdown ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members algo score read" ON shopee.algo_score_breakdown;
CREATE POLICY "org members algo score read"
  ON shopee.algo_score_breakdown FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

GRANT ALL    ON TABLE shopee.algo_score_breakdown TO service_role;
GRANT SELECT ON TABLE shopee.algo_score_breakdown TO authenticated;

-- ── 4. Atualiza roadmap F18 ──────────────────────────────────────────
DO $$
DECLARE
  vazzo_org  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id FROM public.roadmap_phases
   WHERE organization_id = vazzo_org AND num = 'F18';

  IF v_phase_id IS NULL THEN
    RAISE EXCEPTION 'Phase F18 não encontrada — aplicar 20260670 primeiro';
  END IF;

  UPDATE public.roadmap_items
     SET status = 'done', updated_at = now()
   WHERE phase_id = v_phase_id
     AND label LIKE 'F1.1 —%';

  UPDATE public.roadmap_phases
     SET pct = 16, updated_at = now()
   WHERE id = v_phase_id;
END $$;
