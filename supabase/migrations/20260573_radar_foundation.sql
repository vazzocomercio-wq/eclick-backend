-- ════════════════════════════════════════════════════════════════════════════
-- e-Click Radar IA — R1 · Fundação de Banco
-- ════════════════════════════════════════════════════════════════════════════
--
-- Módulo novo `radar` — inteligência de mercado para marketplaces. A unidade de
-- análise é o PRODUTO DE CATÁLOGO: para cada produto de catálogo monitorado, o
-- ML entrega o conjunto competitivo via /products/{id}/items.
--
-- SUBSTITUI o antigo Monitor de Concorrentes (competitors/price_history), que
-- foi modelado em torno de /items/{id} enrichment — endpoint que o ML fechou
-- (403 access_denied para item de terceiro). Spike de viabilidade:
-- docs/spike-radar-ml-feasibility.md.
--
-- Princípios (não-negociáveis):
--   • Multi-tenant   — organization_id + RLS em toda tabela.
--   • Multi-conta    — radar_offers.is_own derivado dinamicamente dos sellers
--                      da org (ml_connections), nunca de id hardcoded.
--   • Multi-market   — coluna `platform` em toda tabela; UNIQUE inclui platform.
--                      MVP 1 implementa só 'mercadolivre'; schema nasce agnóstico.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 1. LIMPEZA — decomissão do Monitor de Concorrentes antigo ───────────────
-- Tabelas descartáveis (competitors 3 linhas, price_history 1, a outra 0).
-- Modeladas em torno da API morta — sem dívida de dados a preservar.
DROP TABLE IF EXISTS public.price_history CASCADE;
DROP TABLE IF EXISTS public.competitor_price_history CASCADE;
DROP TABLE IF EXISTS public.competitors CASCADE;


-- ─── 2. radar_catalog_products — watchlist de produtos de catálogo ───────────
CREATE TABLE IF NOT EXISTS public.radar_catalog_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform            text NOT NULL DEFAULT 'mercadolivre',
  catalog_product_id  text NOT NULL,                       -- MLBU... (produto de catálogo)
  category_id         text,                                -- MLB... categoria
  title               text,
  product_id          uuid REFERENCES public.products(id) ON DELETE SET NULL,
                                                           -- NULLABLE: catálogo monitorado
                                                           -- pode não ser produto vendido
  status              text NOT NULL DEFAULT 'ativo'
                        CHECK (status IN ('ativo', 'pausado')),
  origem              text NOT NULL DEFAULT 'seed-manual'
                        CHECK (origem IN ('auto-catalogo-proprio', 'seed-manual')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radar_catalog_products_uniq UNIQUE (organization_id, platform, catalog_product_id)
);
CREATE INDEX IF NOT EXISTS idx_radar_catalog_products_org_status
  ON public.radar_catalog_products (organization_id, status);

GRANT ALL ON TABLE public.radar_catalog_products TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_catalog_products TO authenticated;
ALTER TABLE public.radar_catalog_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_catalog_products_org ON public.radar_catalog_products
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));


-- ─── 3. radar_sellers — perfil dos vendedores concorrentes ───────────────────
CREATE TABLE IF NOT EXISTS public.radar_sellers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform            text NOT NULL DEFAULT 'mercadolivre',
  seller_id           bigint NOT NULL,                     -- id do vendedor no marketplace
  nickname            text,
  reputation_level    text,                                -- ex: '5_green'
  power_seller_status text,                                 -- platinum|gold|silver|null
  transactions_total  bigint,
  is_official_store   boolean NOT NULL DEFAULT false,
  metrics             jsonb,                               -- métricas finas (variam por seller)
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radar_sellers_uniq UNIQUE (organization_id, platform, seller_id)
);

GRANT ALL ON TABLE public.radar_sellers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_sellers TO authenticated;
ALTER TABLE public.radar_sellers ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_sellers_org ON public.radar_sellers
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));


-- ─── 4. radar_offers — oferta competitiva atual (seller × produto catálogo) ──
CREATE TABLE IF NOT EXISTS public.radar_offers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform            text NOT NULL DEFAULT 'mercadolivre',
  catalog_product_ref uuid NOT NULL REFERENCES public.radar_catalog_products(id) ON DELETE CASCADE,
  seller_ref          uuid NOT NULL REFERENCES public.radar_sellers(id) ON DELETE CASCADE,
  item_id             text NOT NULL,                       -- MLB... do anúncio
  title               text,
  price               numeric,
  free_shipping       boolean,
  logistic_type       text,
  listing_type        text,
  condition           text,
  is_winner           boolean NOT NULL DEFAULT false,      -- ganhador do catálogo
  is_own              boolean NOT NULL DEFAULT false,      -- seller pertence à org
  sold_quantity       int,                                 -- só is_own=true; concorrente é
  available_quantity  int,                                 -- inacessível (NULL) — spike
  permalink           text,
  thumbnail           text,
  status              text NOT NULL DEFAULT 'ativo'
                        CHECK (status IN ('ativo', 'inativo')),
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radar_offers_uniq UNIQUE (organization_id, platform, item_id)
);
CREATE INDEX IF NOT EXISTS idx_radar_offers_catalog
  ON public.radar_offers (organization_id, catalog_product_ref);
CREATE INDEX IF NOT EXISTS idx_radar_offers_seller
  ON public.radar_offers (organization_id, seller_ref);

GRANT ALL ON TABLE public.radar_offers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_offers TO authenticated;
ALTER TABLE public.radar_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_offers_org ON public.radar_offers
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));


-- ─── 5. radar_offer_snapshots — histórico diário das ofertas ─────────────────
-- PARTICIONADA POR MÊS (chave: collected_at). Append-only — a disciplina de
-- 1 snapshot/item/dia é do coletor diário (R2). Sem FK nas refs: snapshot é
-- história pura; as linhas-pai de radar_offers/_catalog_products persistem.
CREATE TABLE IF NOT EXISTS public.radar_offer_snapshots (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  catalog_product_ref uuid NOT NULL,
  item_id             text NOT NULL,
  seller_ref          uuid,
  price               numeric,
  free_shipping       boolean,
  logistic_type       text,
  is_winner           boolean,
  collected_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, collected_at)                           -- PK inclui a chave de partição
) PARTITION BY RANGE (collected_at);

CREATE INDEX IF NOT EXISTS idx_radar_offer_snapshots_item
  ON public.radar_offer_snapshots (organization_id, item_id, collected_at DESC);

GRANT ALL ON TABLE public.radar_offer_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_offer_snapshots TO authenticated;
ALTER TABLE public.radar_offer_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_offer_snapshots_org ON public.radar_offer_snapshots
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

-- Partições do mês corrente + próximos 2
CREATE TABLE IF NOT EXISTS public.radar_offer_snapshots_2026_05
  PARTITION OF public.radar_offer_snapshots FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS public.radar_offer_snapshots_2026_06
  PARTITION OF public.radar_offer_snapshots FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS public.radar_offer_snapshots_2026_07
  PARTITION OF public.radar_offer_snapshots FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');


-- ─── 6. radar_visit_snapshots — série diária de visitas por anúncio ──────────
-- PARTICIONADA POR MÊS (chave: visit_date). Idempotente — a janela de visitas
-- (~30d) é recoletada e faz upsert via radar_visit_snapshots_uniq.
CREATE TABLE IF NOT EXISTS public.radar_visit_snapshots (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  catalog_product_ref uuid NOT NULL,
  item_id             text NOT NULL,
  visit_date          date NOT NULL,
  visits              int NOT NULL DEFAULT 0,
  collected_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, visit_date),                            -- PK inclui a chave de partição
  CONSTRAINT radar_visit_snapshots_uniq UNIQUE (organization_id, item_id, visit_date)
) PARTITION BY RANGE (visit_date);

CREATE INDEX IF NOT EXISTS idx_radar_visit_snapshots_item
  ON public.radar_visit_snapshots (organization_id, item_id, visit_date DESC);

GRANT ALL ON TABLE public.radar_visit_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_visit_snapshots TO authenticated;
ALTER TABLE public.radar_visit_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_visit_snapshots_org ON public.radar_visit_snapshots
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

CREATE TABLE IF NOT EXISTS public.radar_visit_snapshots_2026_05
  PARTITION OF public.radar_visit_snapshots FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS public.radar_visit_snapshots_2026_06
  PARTITION OF public.radar_visit_snapshots FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS public.radar_visit_snapshots_2026_07
  PARTITION OF public.radar_visit_snapshots FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');


-- ─── 7. radar_events — mudanças relevantes detectadas (Motor de Eventos R3) ──
CREATE TABLE IF NOT EXISTS public.radar_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  catalog_product_ref uuid NOT NULL REFERENCES public.radar_catalog_products(id) ON DELETE CASCADE,
  seller_ref          uuid REFERENCES public.radar_sellers(id) ON DELETE SET NULL,
  item_id             text,
  event_type          text NOT NULL CHECK (event_type IN (
                        'queda_preco', 'alta_preco', 'mudanca_buybox',
                        'novo_concorrente', 'saiu_concorrente', 'mudanca_frete')),
  previous_value      jsonb,
  new_value           jsonb,
  severity            text NOT NULL DEFAULT 'info'
                        CHECK (severity IN ('info', 'atencao', 'critico')),
  status              text NOT NULL DEFAULT 'novo'
                        CHECK (status IN ('novo', 'visto', 'arquivado')),
  detected_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_events_org_status
  ON public.radar_events (organization_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_radar_events_catalog
  ON public.radar_events (organization_id, catalog_product_ref, detected_at DESC);

GRANT ALL ON TABLE public.radar_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_events TO authenticated;
ALTER TABLE public.radar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_events_org ON public.radar_events
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));


-- ─── 8. Auto-criação de partições futuras (espelha fn_create_next_snapshot_partition) ──
CREATE OR REPLACE FUNCTION public.fn_create_next_radar_partitions()
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  start_date DATE := DATE_TRUNC('month', CURRENT_DATE + INTERVAL '3 months');
  end_date   DATE := start_date + INTERVAL '1 month';
  ym         TEXT := TO_CHAR(start_date, 'YYYY_MM');
BEGIN
  EXECUTE FORMAT(
    'CREATE TABLE IF NOT EXISTS public.radar_offer_snapshots_%s PARTITION OF public.radar_offer_snapshots FOR VALUES FROM (%L) TO (%L)',
    ym, start_date, end_date
  );
  EXECUTE FORMAT(
    'CREATE TABLE IF NOT EXISTS public.radar_visit_snapshots_%s PARTITION OF public.radar_visit_snapshots FOR VALUES FROM (%L) TO (%L)',
    ym, start_date, end_date
  );
END;
$function$;

-- pg_cron: dia 1 de cada mês, 07:00 (mesmo horário do create_next_snapshot_partition).
-- cron.schedule com nome reusa/atualiza o job se já existir — idempotente.
SELECT cron.schedule(
  'create_next_radar_partition',
  '0 7 1 * *',
  'SELECT public.fn_create_next_radar_partitions()'
);


-- ─── 9. Seed da watchlist — auto-semeado do catálogo próprio ─────────────────
-- Fonte: products.ml_catalog_id (R0 confirmou: product_listings NÃO tem
-- catalog_product_id; o id de catálogo MLBU vive em products.ml_catalog_id).
-- Multi-tenant: semeia o catálogo de TODA org que tiver produtos com ml_catalog_id.
INSERT INTO public.radar_catalog_products
  (organization_id, platform, catalog_product_id, category_id, title, product_id, status, origem)
SELECT DISTINCT ON (p.organization_id, p.ml_catalog_id)
  p.organization_id, 'mercadolivre', p.ml_catalog_id, p.category_ml_id, p.name, p.id,
  'ativo', 'auto-catalogo-proprio'
FROM public.products p
WHERE p.ml_catalog_id IS NOT NULL
ORDER BY p.organization_id, p.ml_catalog_id, p.created_at
ON CONFLICT (organization_id, platform, catalog_product_id) DO NOTHING;


COMMENT ON TABLE public.radar_catalog_products IS
  'e-Click Radar IA — watchlist de produtos de catálogo monitorados. Unidade de análise do módulo.';
COMMENT ON TABLE public.radar_sellers IS
  'e-Click Radar IA — perfil de vendedores concorrentes (reputação via /users/{id}).';
COMMENT ON TABLE public.radar_offers IS
  'e-Click Radar IA — oferta competitiva atual por seller × produto de catálogo. sold/available_quantity só para is_own.';
COMMENT ON TABLE public.radar_offer_snapshots IS
  'e-Click Radar IA — histórico diário das ofertas. Particionada por mês (collected_at).';
COMMENT ON TABLE public.radar_visit_snapshots IS
  'e-Click Radar IA — série diária de visitas por anúncio (sinal de demanda). Particionada por mês (visit_date).';
COMMENT ON TABLE public.radar_events IS
  'e-Click Radar IA — mudanças relevantes detectadas pelo Motor de Eventos (R3).';
