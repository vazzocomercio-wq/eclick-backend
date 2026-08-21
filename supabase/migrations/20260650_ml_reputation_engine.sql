-- ============================================================
-- Módulo de Reputação Mercado Livre — motor de regras versionadas
--
-- O que muda:
--   • Regras (período 60/365, limite de 68 vendas, faixas por métrica)
--     deixam de ser números no código: ficam em `ml_reputation_rule_sets`
--     com vigência (effective_from / effective_until). O backend carrega a
--     regra vigente na data do cálculo e guarda o nome dela em cada
--     resultado (auditoria).
--   • `ml_reputation_current`  = último cálculo LOCAL por (org, seller)
--     (o cache oficial do ML continua em `ml_seller_reputation_current`).
--   • `ml_reputation_snapshots` = 1 linha por (org, seller, dia) — upsert,
--     o último cálculo do dia vence. Mudanças relevantes (troca de faixa,
--     troca de período, risco) viram linhas em `ml_reputation_events`, que
--     também é a base de deduplicação dos alertas.
--   • `ml_reputation_account_counts()` agrega pedidos / reclamações /
--     atrasos de UMA conta em UMA query (janelas móveis calculadas no
--     banco, com o instante passado pelo backend).
--   • `ml_reputation_set_cancel_detail()` grava o `cancel_detail` do ML em
--     pedidos antigos (backfill) sem reescrever o raw_data inteiro.
--
-- Aditiva: não apaga nem altera colunas existentes.
-- ============================================================

-- 1. Conjuntos de regras versionados ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_reputation_rule_sets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace      TEXT NOT NULL DEFAULT 'MERCADO_LIVRE',
  name             TEXT NOT NULL,
  effective_from   DATE,                 -- NULL = desde sempre
  effective_until  DATE,                 -- NULL = sem fim
  config           JSONB NOT NULL,       -- measurement + metrics + risk (ver ml-reputation.types.ts)
  is_builtin       BOOLEAN NOT NULL DEFAULT false,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (marketplace, name)
);

CREATE INDEX IF NOT EXISTS idx_ml_reputation_rule_sets_vigencia
  ON public.ml_reputation_rule_sets(marketplace, effective_from, effective_until);

-- Seed: regra anterior (valores da central de ajuda ML vigentes antes da
-- mudança — limiar de 60 vendas e mesmas faixas nos dois períodos) e a
-- nova metodologia válida a partir de 10/09/2026. Percentuais em PONTOS
-- PERCENTUAIS (2.5 = 2,5%). ON CONFLICT DO NOTHING: se alguém já editou a
-- linha no banco, a migration não sobrescreve.
INSERT INTO public.ml_reputation_rule_sets (marketplace, name, effective_from, effective_until, config, is_builtin, notes)
VALUES
(
  'MERCADO_LIVRE', 'ML_REPUTATION_LEGACY', NULL, DATE '2026-09-09',
  '{
    "measurement": { "shortPeriodDays": 60, "longPeriodDays": 365, "minimumSalesForShortPeriod": 60 },
    "metrics": {
      "cancellations":      { "60": { "green": 2.5,  "yellow": 5.5,  "orange": 6.5  }, "365": { "green": 2.5,  "yellow": 5.5,  "orange": 6.5  } },
      "incorrectShipments": { "60": { "green": 13.0, "yellow": 23.5, "orange": 28.5 }, "365": { "green": 13.0, "yellow": 23.5, "orange": 28.5 } },
      "claims":             { "60": { "green": 2.0,  "yellow": 4.5,  "orange": 8.0  }, "365": { "green": 2.0,  "yellow": 4.5,  "orange": 8.0  } }
    },
    "risk": { "attentionAt": 0.70, "highAt": 0.85, "criticalAt": 0.95 }
  }'::jsonb,
  true,
  'Regra anterior a 10/09/2026. Valores conforme central de ajuda do ML (limiar de 60 vendas; faixas iguais para 60 e 365 dias). Validar contra a página oficial antes de confiar para auditoria retroativa.'
),
(
  'MERCADO_LIVRE', 'ML_REPUTATION_2026_09', DATE '2026-09-10', NULL,
  '{
    "measurement": { "shortPeriodDays": 60, "longPeriodDays": 365, "minimumSalesForShortPeriod": 68 },
    "metrics": {
      "cancellations":      { "60": { "green": 1.5,  "yellow": 3.5,  "orange": 4.0  }, "365": { "green": 2.5,  "yellow": 5.5,  "orange": 6.5  } },
      "incorrectShipments": { "60": { "green": 10.0, "yellow": 18.0, "orange": 22.0 }, "365": { "green": 13.0, "yellow": 23.5, "orange": 28.5 } },
      "claims":             { "60": { "green": 2.0,  "yellow": 4.5,  "orange": 8.0  }, "365": { "green": 2.0,  "yellow": 4.5,  "orange": 8.0  } }
    },
    "risk": { "attentionAt": 0.70, "highAt": 0.85, "criticalAt": 0.95 }
  }'::jsonb,
  true,
  'Nova metodologia válida a partir de 10/09/2026: 68 vendas em 60 dias decidem o período; faixas mais rígidas para quem é avaliado em 60 dias.'
)
ON CONFLICT (marketplace, name) DO NOTHING;

-- 2. Cálculo LOCAL mais recente por conta ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_reputation_current (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id             BIGINT NOT NULL,
  rule_set_name         TEXT,
  measurement_period    INTEGER,                -- 60 | 365
  sales_60d             INTEGER,
  sales_365d            INTEGER,
  overall_level         TEXT,                   -- green | yellow | orange | red | unknown (pior métrica)
  risk_level            TEXT,                   -- safe | attention | high | critical | unknown
  result                JSONB NOT NULL,         -- ReputationResult completo (auditoria: contagens, limites, regra)
  official              JSONB,                  -- trecho oficial do ML usado na comparação
  divergence            JSONB,                  -- { metric: { local, official, delta } } quando relevante
  calculated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  data_as_of            TIMESTAMPTZ,            -- instante usado como "agora" nas janelas
  dirty_since           TIMESTAMPTZ,            -- marcado pelo webhook; cron recalcula
  cancel_backfilled_at  TIMESTAMPTZ,            -- backfill do cancel_detail já rodou
  claims_backfilled_at  TIMESTAMPTZ,            -- backfill de reclamações (claims/search) já rodou
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, seller_id)
);

-- Coluna adicionada depois da 1ª aplicação (idempotente)
ALTER TABLE public.ml_reputation_current ADD COLUMN IF NOT EXISTS claims_backfilled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ml_reputation_current_org_level
  ON public.ml_reputation_current(organization_id, overall_level);
CREATE INDEX IF NOT EXISTS idx_ml_reputation_current_dirty
  ON public.ml_reputation_current(dirty_since) WHERE dirty_since IS NOT NULL;

-- 3. Histórico diário (1 linha por dia; último cálculo do dia vence) ─────
CREATE TABLE IF NOT EXISTS public.ml_reputation_snapshots (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id                 BIGINT NOT NULL,
  snapshot_date             DATE NOT NULL,       -- data em America/Sao_Paulo
  rule_set_name             TEXT,
  measurement_period        INTEGER,
  sales_60d                 INTEGER,
  sales_365d                INTEGER,
  sales_considered          INTEGER,             -- denominador do período aplicado
  cancellation_count        INTEGER,
  cancellation_pct          NUMERIC(9,4),
  cancellation_level        TEXT,
  shipping_issue_count      INTEGER,
  shipping_issue_pct        NUMERIC(9,4),
  shipping_issue_level      TEXT,
  claim_count               INTEGER,
  claim_pct                 NUMERIC(9,4),
  claim_level               TEXT,
  official_level_id         TEXT,
  official_cancellation_pct NUMERIC(9,4),
  official_claims_pct       NUMERIC(9,4),
  official_delayed_pct      NUMERIC(9,4),
  overall_level             TEXT,
  risk_level                TEXT,
  calculated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, seller_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_ml_reputation_snapshots_org_seller_date
  ON public.ml_reputation_snapshots(organization_id, seller_id, snapshot_date DESC);

-- 4. Eventos relevantes (troca de faixa/período, risco) + dedupe de alertas
CREATE TABLE IF NOT EXISTS public.ml_reputation_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id        BIGINT NOT NULL,
  event_type       TEXT NOT NULL,       -- level_changed | period_changed | near_limit | back_to_safe
  metric           TEXT,                -- cancellations | incorrectShipments | claims | NULL (período)
  from_value       TEXT,
  to_value         TEXT,
  severity         TEXT,                -- info | warning | critical
  dedupe_key       TEXT NOT NULL,       -- ex.: level_changed:cancellations:green>yellow
  payload          JSONB,
  alert_signal_id  UUID,                -- alert_signals.id quando virou alerta
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_reputation_events_org_seller_created
  ON public.ml_reputation_events(organization_id, seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_reputation_events_dedupe
  ON public.ml_reputation_events(organization_id, seller_id, dedupe_key, created_at DESC);

-- 5. Função de agregação: UMA query por conta ────────────────────────────
-- `orders` guarda 1 linha por ITEM do pedido → agrupa por external_order_id
-- antes de contar. Janelas móveis: [p_now - N dias, p_now].
--   completed  = venda concluída (status paid/partially_refunded, não cancelada)
--   counted    = venda concretizada (concluída OU cancelada depois de paga)
--                → denominador dos indicadores
--   seller_cancelled = cancelada com cancel_detail.group/requested_by = seller
--   claims     = pedidos com reclamação (ml_claims, exceto pedidos de
--                cancelamento) — amarrados por order_id OU pack_id
--   shipping_issues = pedidos com atraso de manuseio (ml_shipment_delays
--                handling_delayed, affects_reputation), EXCETO Full
--                (logistic_type = fulfillment: manuseio é do ML, não do seller)
-- Performance: JSON só é lido nas linhas canceladas (paid_amount, cancel_detail);
-- reclamações/atrasos entram por `IN (subquery)` (hashed subplan, 1 passada),
-- não por EXISTS correlacionado — em conta com 10k+ pedidos isso é a diferença
-- entre 0,5 s e estourar o statement_timeout do PostgREST.
CREATE OR REPLACE FUNCTION public.ml_reputation_account_counts(
  p_org        UUID,
  p_seller     BIGINT,
  p_now        TIMESTAMPTZ DEFAULT now(),
  p_short_days INTEGER     DEFAULT 60,
  p_long_days  INTEGER     DEFAULT 365
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH claims_counted AS (
  -- Reclamações que pesam contra o seller (estimativa): exclui pedidos de
  -- cancelamento, reclamações resolvidas a favor do vendedor (benefited
  -- contém 'respondent') e as retiradas pelo comprador (closed_by =
  -- complainant sem beneficiado). resource pode ser 'order' ou 'shipment'.
  SELECT c.ml_resource_id::text AS ref, COALESCE(c.raw->>'resource', 'order') AS resource
  FROM public.ml_claims c
  WHERE c.organization_id = p_org
    AND c.ml_resource_id IS NOT NULL
    AND COALESCE(c.type, '') NOT IN ('cancel_purchase', 'cancel_sale')
    AND NOT COALESCE(c.raw->'resolution'->'benefited' ? 'respondent', false)
    AND NOT (
      c.raw->'resolution'->>'closed_by' = 'complainant'
      AND jsonb_array_length(COALESCE(c.raw->'resolution'->'benefited', '[]'::jsonb)) = 0
    )
),
claim_refs AS (
  SELECT DISTINCT ref FROM claims_counted WHERE resource <> 'shipment'
),
claim_ship_refs AS (
  SELECT DISTINCT ref FROM claims_counted WHERE resource = 'shipment'
),
delay_orders AS (
  SELECT DISTINCT d.ml_order_id AS ref
  FROM public.ml_shipment_delays d
  WHERE d.organization_id = p_org AND d.seller_id = p_seller
    AND d.delay_type = 'handling_delayed' AND COALESCE(d.affects_reputation, true)
    AND d.ml_order_id IS NOT NULL
),
delay_ships AS (
  SELECT DISTINCT d.ml_shipment_id AS ref
  FROM public.ml_shipment_delays d
  WHERE d.organization_id = p_org AND d.seller_id = p_seller
    AND d.delay_type = 'handling_delayed' AND COALESCE(d.affects_reputation, true)
    AND d.ml_shipment_id IS NOT NULL
),
base AS (
  SELECT
    o.external_order_id,
    min(o.sold_at)                                              AS sold_at,
    bool_or(o.status = 'cancelled')                             AS is_cancelled,
    bool_or(o.status IN ('paid', 'partially_refunded'))         AS is_paid,
    max(CASE WHEN o.status = 'cancelled'
             THEN COALESCE(NULLIF(o.raw_data->>'paid_amount', '')::numeric, 0)
             ELSE 0 END)                                        AS cancelled_paid,
    bool_or(o.status = 'cancelled' AND (
      (o.raw_data->'cancel_detail'->>'group') = 'seller'
      OR (o.raw_data->'cancel_detail'->>'requested_by') = 'seller'
    ))                                                          AS cancelled_by_seller,
    bool_or(o.status = 'cancelled' AND (o.raw_data ? 'cancel_detail')) AS has_cancel_detail,
    bool_or(o.raw_data->'shipping'->>'logistic_type' = 'fulfillment') AS is_full,
    max(o.shipping_id::text)                                    AS shipping_id,
    max(o.raw_data->>'pack_id')                                 AS pack_id
  FROM public.orders o
  WHERE o.organization_id = p_org
    AND o.seller_id       = p_seller
    AND o.platform        = 'mercadolivre'
    AND o.external_order_id IS NOT NULL
    AND o.sold_at >= p_now - make_interval(days => p_long_days)
    AND o.sold_at <= p_now
  GROUP BY o.external_order_id
),
flagged AS (
  SELECT
    b.*,
    (b.is_paid AND NOT b.is_cancelled)                          AS completed,
    (b.is_paid OR (b.is_cancelled AND b.cancelled_paid > 0))    AS counted,
    (b.is_cancelled AND b.cancelled_paid > 0 AND b.cancelled_by_seller) AS seller_cancelled,
    (b.sold_at >= p_now - make_interval(days => p_short_days))  AS in_short,
    (b.external_order_id IN (SELECT ref FROM claim_refs)
      OR (b.pack_id IS NOT NULL AND b.pack_id IN (SELECT ref FROM claim_refs))
      OR (b.shipping_id IS NOT NULL AND b.shipping_id IN (SELECT ref FROM claim_ship_refs))) AS has_claim,
    (NOT b.is_full AND (
      b.external_order_id IN (SELECT ref FROM delay_orders)
      OR (b.shipping_id IS NOT NULL AND b.shipping_id IN (SELECT ref FROM delay_ships)))) AS has_shipping_issue
  FROM base b
),
agg AS (
  SELECT
    count(*) FILTER (WHERE completed AND in_short)                     AS short_completed,
    count(*) FILTER (WHERE counted   AND in_short)                     AS short_counted,
    count(*) FILTER (WHERE seller_cancelled AND in_short)              AS short_seller_cancelled,
    count(*) FILTER (WHERE counted AND has_claim AND in_short)         AS short_claims,
    count(*) FILTER (WHERE counted AND has_shipping_issue AND in_short) AS short_shipping_issues,
    count(*) FILTER (WHERE completed)                                  AS long_completed,
    count(*) FILTER (WHERE counted)                                    AS long_counted,
    count(*) FILTER (WHERE seller_cancelled)                           AS long_seller_cancelled,
    count(*) FILTER (WHERE counted AND has_claim)                      AS long_claims,
    count(*) FILTER (WHERE counted AND has_shipping_issue)             AS long_shipping_issues,
    count(*) FILTER (WHERE is_cancelled)                               AS cancelled_total,
    count(*) FILTER (WHERE is_cancelled AND has_cancel_detail)         AS cancelled_with_detail,
    min(sold_at)                                                       AS oldest_sale_at
  FROM flagged
),
exits AS (
  -- vendas concluídas que vão SAIR da janela curta nos próximos 14 dias
  SELECT COALESCE(jsonb_agg(sold_at ORDER BY sold_at), '[]'::jsonb) AS list
  FROM (
    SELECT sold_at
    FROM flagged
    WHERE completed
      AND sold_at >= p_now - make_interval(days => p_short_days)
      AND sold_at <  p_now - make_interval(days => p_short_days) + interval '14 days'
    ORDER BY sold_at
    LIMIT 500
  ) x
),
coverage AS (
  SELECT
    (SELECT min(date_created) FROM public.ml_claims WHERE organization_id = p_org)                                     AS claims_since,
    (SELECT min(detected_at)  FROM public.ml_shipment_delays WHERE organization_id = p_org AND seller_id = p_seller)  AS delays_since
)
SELECT jsonb_build_object(
  'as_of',        p_now,
  'short_days',   p_short_days,
  'long_days',    p_long_days,
  'short', jsonb_build_object(
    'completed',        a.short_completed,
    'counted',          a.short_counted,
    'seller_cancelled', a.short_seller_cancelled,
    'claims',           a.short_claims,
    'shipping_issues',  a.short_shipping_issues
  ),
  'long', jsonb_build_object(
    'completed',        a.long_completed,
    'counted',          a.long_counted,
    'seller_cancelled', a.long_seller_cancelled,
    'claims',           a.long_claims,
    'shipping_issues',  a.long_shipping_issues
  ),
  'cancel_detail_coverage', jsonb_build_object(
    'cancelled_total',       a.cancelled_total,
    'cancelled_with_detail', a.cancelled_with_detail
  ),
  'oldest_sale_at',  a.oldest_sale_at,
  'claims_since',    c.claims_since,
  'delays_since',    c.delays_since,
  'window_exits',    e.list
)
FROM agg a, exits e, coverage c;
$$;

-- 6. Backfill do cancel_detail sem reescrever o raw_data ─────────────────
CREATE OR REPLACE FUNCTION public.ml_reputation_set_cancel_detail(
  p_org               UUID,
  p_seller            BIGINT,
  p_external_order_id TEXT,
  p_detail            JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE public.orders
     SET raw_data   = COALESCE(raw_data, '{}'::jsonb) || jsonb_build_object('cancel_detail', p_detail),
         updated_at = now()
   WHERE organization_id   = p_org
     AND seller_id         = p_seller
     AND external_order_id = p_external_order_id
     AND platform          = 'mercadolivre';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 6b. Mesmo backfill em LOTE: p_items = [{"id": "2000001", "detail": {...}}, …]
-- (1 chamada por página de 50 pedidos em vez de 1 por pedido — conta com
-- 1.000 cancelados passa de ~2 min pra segundos). Retorna linhas atualizadas.
CREATE OR REPLACE FUNCTION public.ml_reputation_set_cancel_details(
  p_org    UUID,
  p_seller BIGINT,
  p_items  JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE public.orders o
     SET raw_data   = COALESCE(o.raw_data, '{}'::jsonb) || jsonb_build_object('cancel_detail', i.detail),
         updated_at = now()
    FROM (
      SELECT x->>'id' AS id, x->'detail' AS detail
      FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS x
      WHERE x ? 'id' AND x ? 'detail'
    ) i
   WHERE o.organization_id   = p_org
     AND o.seller_id         = p_seller
     AND o.platform          = 'mercadolivre'
     AND o.external_order_id = i.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 7. RLS + GRANTs ─────────────────────────────────────────────────────────
-- Tabelas criadas via _admin_exec_sql NÃO recebem default privileges:
-- GRANT explícito obrigatório (senão "permission denied" mesmo com policy).
ALTER TABLE public.ml_reputation_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_reputation_current   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_reputation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_reputation_events    ENABLE ROW LEVEL SECURITY;

-- Regras são globais do marketplace: qualquer usuário autenticado pode LER
-- (o modal "Entenda as regras" pode consumir direto); escrita só service_role.
DROP POLICY IF EXISTS ml_reputation_rule_sets_select ON public.ml_reputation_rule_sets;
CREATE POLICY ml_reputation_rule_sets_select ON public.ml_reputation_rule_sets
  FOR SELECT TO authenticated USING (true);

-- Tabelas por org: leitura só para membros da org.
DROP POLICY IF EXISTS ml_reputation_current_select ON public.ml_reputation_current;
CREATE POLICY ml_reputation_current_select ON public.ml_reputation_current
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS ml_reputation_snapshots_select ON public.ml_reputation_snapshots;
CREATE POLICY ml_reputation_snapshots_select ON public.ml_reputation_snapshots
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS ml_reputation_events_select ON public.ml_reputation_events;
CREATE POLICY ml_reputation_events_select ON public.ml_reputation_events
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

GRANT ALL    ON TABLE public.ml_reputation_rule_sets TO service_role;
GRANT SELECT ON TABLE public.ml_reputation_rule_sets TO authenticated;
GRANT ALL    ON TABLE public.ml_reputation_current   TO service_role;
GRANT SELECT ON TABLE public.ml_reputation_current   TO authenticated;
GRANT ALL    ON TABLE public.ml_reputation_snapshots TO service_role;
GRANT SELECT ON TABLE public.ml_reputation_snapshots TO authenticated;
GRANT ALL    ON TABLE public.ml_reputation_events    TO service_role;
GRANT SELECT ON TABLE public.ml_reputation_events    TO authenticated;

-- Funções: só o backend (service_role) executa.
REVOKE ALL ON FUNCTION public.ml_reputation_account_counts(UUID, BIGINT, TIMESTAMPTZ, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ml_reputation_account_counts(UUID, BIGINT, TIMESTAMPTZ, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.ml_reputation_set_cancel_detail(UUID, BIGINT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ml_reputation_set_cancel_detail(UUID, BIGINT, TEXT, JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.ml_reputation_set_cancel_details(UUID, BIGINT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ml_reputation_set_cancel_details(UUID, BIGINT, JSONB) TO service_role;

COMMENT ON TABLE public.ml_reputation_rule_sets IS
  'Regras de reputação ML versionadas por vigência (período 60/365, limiar de vendas, faixas por métrica, níveis de risco). Editar aqui muda o cálculo sem deploy.';
COMMENT ON TABLE public.ml_reputation_current IS
  'Último cálculo LOCAL de reputação ML por (org, seller). result = ReputationResult completo (auditoria). Oficial do ML fica em ml_seller_reputation_current.';
COMMENT ON TABLE public.ml_reputation_snapshots IS
  'Histórico diário do cálculo local + oficial. 1 linha por dia; o último cálculo do dia vence (upsert).';
COMMENT ON TABLE public.ml_reputation_events IS
  'Mudanças relevantes de reputação (faixa, período, risco). dedupe_key + created_at sustentam o cooldown dos alertas.';

-- ROLLBACK (manual):
--   DROP FUNCTION IF EXISTS public.ml_reputation_set_cancel_details(UUID, BIGINT, JSONB);
--   DROP FUNCTION IF EXISTS public.ml_reputation_set_cancel_detail(UUID, BIGINT, TEXT, JSONB);
--   DROP FUNCTION IF EXISTS public.ml_reputation_account_counts(UUID, BIGINT, TIMESTAMPTZ, INTEGER, INTEGER);
--   DROP TABLE IF EXISTS public.ml_reputation_events;
--   DROP TABLE IF EXISTS public.ml_reputation_snapshots;
--   DROP TABLE IF EXISTS public.ml_reputation_current;
--   DROP TABLE IF EXISTS public.ml_reputation_rule_sets;
