-- ============================================
-- F11 Fase 2 — Migration 3.D/3
-- VIEW v_leaderboard_visits_low_conv v2 — benchmark hierárquico
--
-- Mudanças vs v1 (20260551):
--   - CTE seller_avg adicionada (fallback)
--   - benchmark = COALESCE(cat_avg, seller_avg) hierárquico
--   - WHERE estrito: removeu OR avg IS NULL — items sem benchmark NÃO entram
--   - HAVING sample>=3 em ambos os benchmarks (evita "categoria de 1 item ser benchmark de si mesma")
--   - benchmark_source exposto (category|seller|none) pro frontend
-- ============================================

-- DROP + CREATE necessário porque v1 tinha colunas category_avg_pct/conversion_gap_pct/
-- conv_ratio_vs_category — v2 renomeia pra benchmark_avg/gap_pct/conv_ratio_vs_benchmark
-- e adiciona benchmark_source. Postgres 42P16: CREATE OR REPLACE não renomeia.
DROP VIEW IF EXISTS public.v_leaderboard_visits_low_conv;

CREATE VIEW public.v_leaderboard_visits_low_conv AS
WITH latest_period AS (
  SELECT organization_id, MAX(period_end) AS period_end
  FROM public.ml_item_visits_period
  WHERE period_days = 7
  GROUP BY organization_id
),
visits_7d AS (
  SELECT
    v.organization_id, v.seller_id, v.ml_item_id,
    v.total_visits AS visits_7d,
    v.daily_breakdown
  FROM public.ml_item_visits_period v
  JOIN latest_period lp
    ON lp.organization_id = v.organization_id
   AND lp.period_end       = v.period_end
  WHERE v.period_days = 7
    AND v.error_message IS NULL
),
sales_7d AS (
  SELECT
    o.organization_id,
    o.seller_id,
    o.marketplace_listing_id                      AS ml_item_id,
    COUNT(*)::bigint                              AS orders_7d,
    SUM(o.quantity)::bigint                       AS units_7d,
    SUM(o.sale_price * o.quantity)::numeric(14,2) AS gmv_7d
  FROM public.orders o
  WHERE o.platform = 'mercadolivre'
    AND o.status   = 'paid'
    AND o.created_at >= CURRENT_DATE - INTERVAL '7 days'
    AND o.marketplace_listing_id IS NOT NULL
  GROUP BY o.organization_id, o.seller_id, o.marketplace_listing_id
),
listings AS (
  SELECT
    pl.listing_id      AS ml_item_id,
    pl.listing_title,
    pl.listing_price,
    pl.listing_permalink,
    pl.product_id,
    p.organization_id,
    p.category_ml_id
  FROM public.product_listings pl
  JOIN public.products p ON p.id = pl.product_id
  WHERE pl.platform  = 'mercadolivre'
    AND pl.is_active = true
),
combined AS (
  SELECT
    v.organization_id, v.seller_id, v.ml_item_id,
    v.visits_7d, v.daily_breakdown,
    COALESCE(s.orders_7d, 0) AS orders_7d,
    COALESCE(s.units_7d,  0) AS units_7d,
    COALESCE(s.gmv_7d,    0) AS gmv_7d,
    l.listing_title, l.listing_price, l.listing_permalink,
    l.product_id, l.category_ml_id,
    CASE WHEN v.visits_7d > 0
      THEN COALESCE(s.orders_7d, 0)::numeric / v.visits_7d
      ELSE 0
    END AS conversion_rate
  FROM visits_7d v
  LEFT JOIN sales_7d s
    ON s.organization_id = v.organization_id
   AND s.seller_id        = v.seller_id
   AND s.ml_item_id       = v.ml_item_id
  LEFT JOIN listings l
    ON l.organization_id = v.organization_id
   AND l.ml_item_id       = v.ml_item_id
),
-- Benchmark nível 1: média por categoria (preferido)
category_avg AS (
  SELECT
    organization_id,
    category_ml_id,
    AVG(conversion_rate) FILTER (WHERE visits_7d >= 100) AS cat_avg,
    COUNT(*)             FILTER (WHERE visits_7d >= 100) AS cat_sample
  FROM combined
  WHERE category_ml_id IS NOT NULL
  GROUP BY organization_id, category_ml_id
  HAVING COUNT(*) FILTER (WHERE visits_7d >= 100) >= 3
),
-- Benchmark nível 2: média por seller (fallback)
seller_avg AS (
  SELECT
    organization_id,
    seller_id,
    AVG(conversion_rate) FILTER (WHERE visits_7d >= 100) AS sel_avg,
    COUNT(*)             FILTER (WHERE visits_7d >= 100) AS sel_sample
  FROM combined
  GROUP BY organization_id, seller_id
  HAVING COUNT(*) FILTER (WHERE visits_7d >= 100) >= 3
)
SELECT
  c.organization_id,
  c.seller_id,
  c.ml_item_id,
  c.product_id,
  c.listing_title       AS title,
  c.category_ml_id,
  c.listing_permalink   AS permalink,
  c.listing_price       AS current_price,
  c.visits_7d,
  c.orders_7d,
  c.units_7d,
  c.gmv_7d,
  ROUND(c.conversion_rate * 100, 2) AS conversion_pct,
  -- Benchmark hierárquico
  COALESCE(ca.cat_avg, sa.sel_avg)                 AS benchmark_avg,
  ROUND(COALESCE(ca.cat_avg, sa.sel_avg) * 100, 2) AS benchmark_pct,
  CASE
    WHEN ca.cat_avg  IS NOT NULL THEN 'category'
    WHEN sa.sel_avg  IS NOT NULL THEN 'seller'
    ELSE 'none'
  END                                              AS benchmark_source,
  COALESCE(ca.cat_sample, sa.sel_sample)           AS benchmark_sample_size,
  ROUND((COALESCE(ca.cat_avg, sa.sel_avg) - c.conversion_rate) * 100, 2) AS gap_pct,
  CASE
    WHEN COALESCE(ca.cat_avg, sa.sel_avg) IS NULL
      OR COALESCE(ca.cat_avg, sa.sel_avg) = 0
        THEN NULL
    ELSE ROUND((c.conversion_rate / COALESCE(ca.cat_avg, sa.sel_avg))::numeric, 3)
  END AS conv_ratio_vs_benchmark,
  -- Score: visits × gap absoluto (gap positivo apenas)
  ROUND(
    (c.visits_7d * GREATEST(
      COALESCE(ca.cat_avg, sa.sel_avg, 0) - c.conversion_rate,
      0
    ))::numeric,
    2
  ) AS opportunity_score,
  c.daily_breakdown AS visits_daily_breakdown
FROM combined c
LEFT JOIN category_avg ca
  ON ca.organization_id = c.organization_id
 AND ca.category_ml_id  = c.category_ml_id
LEFT JOIN seller_avg sa
  ON sa.organization_id = c.organization_id
 AND sa.seller_id        = c.seller_id
WHERE c.visits_7d >= 500
  AND COALESCE(ca.cat_avg, sa.sel_avg) IS NOT NULL                    -- exige benchmark
  AND c.conversion_rate < COALESCE(ca.cat_avg, sa.sel_avg) * 0.5      -- conv < 50% benchmark
ORDER BY opportunity_score DESC NULLS LAST, visits_7d DESC;

COMMENT ON VIEW public.v_leaderboard_visits_low_conv IS
  'F11 Fase 2 v2: ranking de items com alto tráfego e baixa conversão vs benchmark hierárquico (categoria preferida, seller fallback). Filtros: visits_7d>=500 AND conv < 50% benchmark. Benchmark requer sample>=3 items com 100+ visitas. Score = visits × gap absoluto. Card "Visita sem Venda" do dashboard executivo consome top 20.';

GRANT SELECT ON public.v_leaderboard_visits_low_conv TO authenticated, service_role;
