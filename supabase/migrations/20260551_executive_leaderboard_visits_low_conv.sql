-- ============================================
-- F11 Fase 2 — Migration 3.B/3
-- Leaderboard "muita visita, pouca venda"
--
-- VIEW agregadora que cruza ml_item_visits_period (Bloco 3.A) com
-- orders + product_listings + products pra rankear itens com tráfego
-- alto e conversão abaixo da média da categoria.
--
-- Schemas reais validados no smoke prévio:
--   orders.marketplace_listing_id (NÃO ml_item_id)
--   orders.created_at (NÃO date_created)
--   orders.status='paid' (exclui cancelled + partially_refunded)
--   product_listings.listing_id (NÃO ml_item_id), listing_title/price/permalink
--   product_listings sem category_id — JOIN com products.category_ml_id
--
-- latest_period CTE → resiliente a cron atrasado ou rodando 2x/dia.
-- ============================================

CREATE OR REPLACE VIEW public.v_leaderboard_visits_low_conv AS
WITH latest_period AS (
  -- Pega o último period_end disponível pra cada org — não hardcode CURRENT_DATE
  SELECT organization_id, MAX(period_end) AS period_end
  FROM public.ml_item_visits_period
  WHERE period_days = 7
  GROUP BY organization_id
),
visits_7d AS (
  SELECT
    v.organization_id,
    v.seller_id,
    v.ml_item_id,
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
    o.marketplace_listing_id                       AS ml_item_id,
    COUNT(*)::bigint                               AS orders_7d,
    SUM(o.quantity)::bigint                        AS units_7d,
    SUM(o.sale_price * o.quantity)::numeric(14,2)  AS gmv_7d
  FROM public.orders o
  WHERE o.platform = 'mercadolivre'
    AND o.status = 'paid'
    AND o.created_at >= CURRENT_DATE - INTERVAL '7 days'
    AND o.marketplace_listing_id IS NOT NULL
  GROUP BY o.organization_id, o.seller_id, o.marketplace_listing_id
),
listings AS (
  SELECT
    pl.listing_id           AS ml_item_id,
    pl.listing_title,
    pl.listing_price,
    pl.listing_permalink,
    pl.product_id,
    p.organization_id,
    p.category_ml_id
  FROM public.product_listings pl
  JOIN public.products p ON p.id = pl.product_id
  WHERE pl.platform = 'mercadolivre'
    AND pl.is_active = true
),
combined AS (
  SELECT
    v.organization_id,
    v.seller_id,
    v.ml_item_id,
    v.visits_7d,
    v.daily_breakdown,
    COALESCE(s.orders_7d, 0) AS orders_7d,
    COALESCE(s.units_7d, 0)  AS units_7d,
    COALESCE(s.gmv_7d, 0)    AS gmv_7d,
    l.listing_title,
    l.listing_price,
    l.listing_permalink,
    l.product_id,
    l.category_ml_id,
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
category_avg AS (
  SELECT
    organization_id,
    category_ml_id,
    AVG(conversion_rate) FILTER (WHERE visits_7d >= 100) AS avg_conv_category,
    COUNT(*) FILTER (WHERE visits_7d >= 100)              AS sample_size
  FROM combined
  WHERE category_ml_id IS NOT NULL
  GROUP BY organization_id, category_ml_id
)
SELECT
  c.organization_id,
  c.seller_id,
  c.ml_item_id,
  c.product_id,
  c.listing_title                                          AS title,
  c.category_ml_id,
  c.listing_permalink                                      AS permalink,
  c.listing_price                                          AS current_price,
  c.visits_7d,
  c.orders_7d,
  c.units_7d,
  c.gmv_7d,
  ROUND(c.conversion_rate * 100, 2)                        AS conversion_pct,
  ROUND(ca.avg_conv_category * 100, 2)                     AS category_avg_pct,
  ROUND((ca.avg_conv_category - c.conversion_rate) * 100, 2) AS conversion_gap_pct,
  CASE
    WHEN ca.avg_conv_category IS NULL OR ca.avg_conv_category = 0 THEN NULL
    ELSE ROUND((c.conversion_rate / ca.avg_conv_category)::numeric, 3)
  END                                                      AS conv_ratio_vs_category,
  ROUND(
    (c.visits_7d * GREATEST(COALESCE(ca.avg_conv_category, 0) - c.conversion_rate, 0))::numeric,
    2
  )                                                        AS opportunity_score,
  ca.sample_size                                           AS category_sample_size,
  c.daily_breakdown                                        AS visits_daily_breakdown
FROM combined c
LEFT JOIN category_avg ca
  ON ca.organization_id = c.organization_id
 AND ca.category_ml_id  = c.category_ml_id
WHERE c.visits_7d >= 500
  AND (
    ca.avg_conv_category IS NULL
    OR c.conversion_rate < ca.avg_conv_category * 0.5
  )
ORDER BY opportunity_score DESC NULLS LAST, visits_7d DESC;

COMMENT ON VIEW public.v_leaderboard_visits_low_conv IS
  'F11 Fase 2: ranking de itens ML com alto tráfego e baixa conversão vs média da categoria (>=500 visitas/7d, conv < 50% da média OU categoria sem benchmark). Score = visitas × gap absoluto. Pega último period_end disponível por org (resiliente a cron atrasado). Card "Visita sem Venda" do dashboard executivo consome top 20.';

GRANT SELECT ON public.v_leaderboard_visits_low_conv TO authenticated, service_role;

-- Índices auxiliares ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ix_orders_ml_listing_paid_recent
  ON public.orders (organization_id, marketplace_listing_id, created_at DESC)
  WHERE platform = 'mercadolivre' AND status = 'paid';

CREATE INDEX IF NOT EXISTS ix_product_listings_ml_active
  ON public.product_listings (listing_id)
  WHERE platform = 'mercadolivre' AND is_active = true;
