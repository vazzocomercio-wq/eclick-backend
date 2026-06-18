-- Radar de Tendências — estimativa de vendas (visitas × conversão).
-- Vendas reais de concorrente o ML não expõe; a estimativa usa as visitas
-- (históricas, reais) × uma taxa de conversão configurável por org.
ALTER TABLE public.trends_settings
  ADD COLUMN IF NOT EXISTS est_conversion_pct numeric NOT NULL DEFAULT 1.5;

-- visitas/dia (média recente) cacheada por produto, pra estimativa na lista.
ALTER TABLE public.trends_products
  ADD COLUMN IF NOT EXISTS visits_per_day numeric;

-- view do radar recriada incluindo visits_per_day (DROP+CREATE: CREATE OR
-- REPLACE não permite inserir coluna no meio da lista)
DROP VIEW IF EXISTS public.v_trends_radar;
CREATE VIEW public.v_trends_radar AS
SELECT
  p.id              AS product_id,
  p.organization_id,
  p.platform,
  p.external_id,
  p.kind,
  p.name,
  p.category_id,
  p.category_name,
  p.domain_id,
  p.price_ref_cents,
  p.visits_per_day,
  p.status,
  p.thumbnail,
  p.url,
  p.first_seen_at,
  p.last_seen_at,
  s.trend_score,
  s.momentum,
  s.volume_score,
  s.breadth_score,
  s.best_seller_rank,
  s.rank_delta,
  s.buy_decision,
  s.margin_estimate_pct,
  s.confidence,
  s.ai_rationale,
  s.components,
  s.computed_at,
  (w.id IS NOT NULL) AS in_watchlist,
  w.decision         AS watch_decision
FROM public.trends_products p
LEFT JOIN public.trends_scores    s ON s.product_id = p.id
LEFT JOIN public.trends_watchlist w ON w.product_id = p.id;

GRANT SELECT ON public.v_trends_radar TO authenticated, service_role;
