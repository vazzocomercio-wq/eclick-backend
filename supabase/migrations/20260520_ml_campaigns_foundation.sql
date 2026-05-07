-- ============================================================
-- F8 ML Campaign Center IA — Camada 1 (K1)
-- Sync + Health Check
-- ============================================================
-- Schema ajustado pos-smoke-test em VAZZO_ (seller 2290161131):
--
-- Findings que mudaram a spec original:
--  1) name/start_date/finish_date/deadline_date sao NULLABLE
--     (LIGHTNING retorna shape minimo com so id/type/status)
--  2) Subsidio MELI vem em /seller-promotions/items/:itemId
--     (campos meli_percentage + seller_percentage por item),
--     NAO em /seller-promotions/users (listagem). Movido pra
--     ml_campaign_items.
--  3) Campos de preco no shape ML sao discounted (suggested_*,
--     min_*, max_*, max_top_*) — renomeados.
--  4) Status 'pending' eh raro (campanha aderida aguardando
--     comecar) — pendente no enum mas nao bloqueia.
--  5) Stock vem como objeto { min, max } em LIGHTNING.
--
-- Sem webhooks na v1 (cron 4x/dia) — sem ml_campaign_notifications.
-- ============================================================

-- ─── 1. ml_campaigns (cache de /seller-promotions/users/:id) ──
CREATE TABLE IF NOT EXISTS ml_campaigns (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,

  -- IDs ML
  ml_campaign_id              text NOT NULL,
  ml_promotion_type           text NOT NULL CHECK (ml_promotion_type IN (
    'MARKETPLACE_CAMPAIGN', 'DEAL', 'PRICE_DISCOUNT',
    'LIGHTNING', 'DOD', 'VOLUME', 'PRE_NEGOTIATED',
    'SELLER_CAMPAIGN', 'SMART', 'PRICE_MATCHING',
    'UNHEALTHY_STOCK', 'SELLER_COUPON_CAMPAIGN'
  )),

  -- Identificacao (NULLABLE — LIGHTNING nao retorna)
  name                        text,
  description                 text,

  -- Periodo (NULLABLE — LIGHTNING nao retorna)
  start_date                  timestamptz,
  finish_date                 timestamptz,
  deadline_date               timestamptz,           -- prazo limite pra aderir

  -- Status
  status                      text NOT NULL CHECK (status IN (
    'pending',     -- aderida, aguardando inicio (raro)
    'started',     -- ativa
    'finished',    -- encerrada
    'paused',      -- pausada
    'expired'      -- expirou
  )),

  -- Restricoes (raramente vem na listagem)
  min_discount_pct            numeric,
  max_discount_pct            numeric,
  min_stock_required          integer,
  category_filters            jsonb DEFAULT '{}'::jsonb,

  -- Contadores (atualizados pelo sync de items)
  candidate_count             integer DEFAULT 0,
  pending_count               integer DEFAULT 0,
  started_count               integer DEFAULT 0,
  finished_count              integer DEFAULT 0,

  -- Agregados de subsidio (calculados na Fase B do sync) —
  -- subsidio eh por item (vem de /seller-promotions/items/:id),
  -- mas o usuario quer filtro rapido "essa campanha tem subsidio?"
  has_subsidy_items           boolean DEFAULT false,
  items_with_subsidy_count    integer DEFAULT 0,
  avg_meli_subsidy_pct        numeric,               -- media meli_percentage

  -- Analise interna (preenchido por Camada 2)
  recommendation_summary      jsonb DEFAULT '{}'::jsonb,

  -- Raw response (debug)
  raw_response                jsonb,

  -- Sync
  last_synced_at              timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id, ml_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_camp_org_seller
  ON ml_campaigns(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_ml_camp_status
  ON ml_campaigns(organization_id, seller_id, status);
CREATE INDEX IF NOT EXISTS idx_ml_camp_type
  ON ml_campaigns(organization_id, seller_id, ml_promotion_type);
CREATE INDEX IF NOT EXISTS idx_ml_camp_deadline
  ON ml_campaigns(deadline_date)
  WHERE status IN ('pending', 'started');
CREATE INDEX IF NOT EXISTS idx_ml_camp_subsidy
  ON ml_campaigns(organization_id, seller_id)
  WHERE has_subsidy_items = true;

-- ─── 2. ml_campaign_items (item × campanha) ──────────────────
CREATE TABLE IF NOT EXISTS ml_campaign_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,
  campaign_id                 uuid NOT NULL REFERENCES ml_campaigns(id) ON DELETE CASCADE,
  product_id                  uuid REFERENCES products(id) ON DELETE SET NULL,

  -- IDs ML
  ml_item_id                  text NOT NULL,
  ml_campaign_id              text NOT NULL,
  ml_promotion_type           text NOT NULL,
  ml_offer_id                 text,                  -- se ja participa, ID da oferta
  ref_id                      text,                  -- 'CANDIDATE-MLBxxx-...' identifier

  -- Status na campanha
  status                      text NOT NULL CHECK (status IN (
    'candidate',  -- elegivel, ainda nao participa
    'pending',    -- aderiu, aguardando inicio (raro)
    'started',    -- participando ativamente
    'finished'    -- saiu da campanha
  )),

  -- Precos (do ML — shape com 'discounted' nos nomes)
  original_price              numeric,
  current_price               numeric,               -- preco atual quando started (era 'campaign_price')
  suggested_discounted_price  numeric,               -- sugerido pelo ML
  min_discounted_price        numeric,               -- minimo aceito
  max_discounted_price        numeric,               -- maximo aceito
  max_top_discounted_price    numeric,               -- preco TOP (visibilidade Meli+ premium)

  -- Subsidio MELI (vem por item via /seller-promotions/items/:id)
  meli_percentage             numeric,               -- ML subsidia X%
  seller_percentage           numeric,               -- seller paga Y%
  meli_subsidy_amount         numeric,               -- R$ que o ML reduz da tarifa
  seller_pays_amount          numeric,               -- R$ que o seller da de desconto
  has_meli_subsidy            boolean DEFAULT false,

  -- Quantidade (para LIGHTNING + VOLUME)
  configured_quantity         integer,
  min_quantity                integer,               -- minimo aceito
  max_quantity                integer,               -- maximo aceito

  -- Camada Meli+ (premium top) — adesao SEPARADA do preco promocional comum
  -- O Mercado Turbo mostra "Configure" no Meli+ (UX), exige outro POST
  -- pra essa camada. Capturado agora pra evitar migration v1.1.
  top_offer_id                text,                  -- offer_id da camada Meli+
  top_offer_price             numeric,               -- preco configurado em Meli+
  participates_in_top         boolean DEFAULT false,

  -- Calculos internos (atualizados quando muda preco/custo)
  estimated_revenue           numeric,               -- liquido apos tarifas
  estimated_margin_brl        numeric,               -- M.C. (R$)
  estimated_margin_pct        numeric,               -- M.C. (%)
  break_even_price            numeric,               -- preco minimo pra nao dar prejuizo

  -- Health check
  has_cost_data               boolean DEFAULT false,
  has_tax_data                boolean DEFAULT false,
  has_dimensions              boolean DEFAULT false,
  health_status               text CHECK (health_status IN (
    'ready',           -- tudo cadastrado
    'missing_cost',
    'missing_tax',
    'missing_shipping',
    'incomplete'       -- multiplos faltantes
  )),
  health_warnings             jsonb DEFAULT '[]'::jsonb,

  -- Raw response
  raw_response                jsonb,

  -- Sync
  last_synced_at              timestamptz NOT NULL DEFAULT now(),
  last_subsidy_synced_at      timestamptz,           -- quando a Fase B enriqueceu
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (campaign_id, ml_item_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_camp_items_org_seller
  ON ml_campaign_items(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_ml_camp_items_product
  ON ml_campaign_items(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ml_camp_items_status
  ON ml_campaign_items(organization_id, seller_id, status);
CREATE INDEX IF NOT EXISTS idx_ml_camp_items_health
  ON ml_campaign_items(organization_id, seller_id, health_status);
CREATE INDEX IF NOT EXISTS idx_ml_camp_items_item
  ON ml_campaign_items(organization_id, ml_item_id);
CREATE INDEX IF NOT EXISTS idx_ml_camp_items_subsidy
  ON ml_campaign_items(organization_id, seller_id)
  WHERE has_meli_subsidy = true;

-- ─── 3. ml_listing_prices_cache (custos ML por categoria) ────
-- Cache de /sites/MLB/listing_prices. ML cobra comissao por
-- (categoria, faixa de preco, tipo logistica). TTL 7d + flag
-- last_validated_at pra revalidar caso ML mude comissao.
CREATE TABLE IF NOT EXISTS ml_listing_prices_cache (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Chave de cache
  ml_category_id              text NOT NULL,
  listing_type_id             text NOT NULL DEFAULT 'gold_special',
  logistic_type               text,
  shipping_mode               text,
  price_range_min             numeric,
  price_range_max             numeric,

  -- Custos
  sale_fee_amount             numeric,
  sale_fee_percentage         numeric,
  fixed_fee                   numeric,
  free_shipping_cost          numeric,

  -- Raw
  raw_response                jsonb,

  -- Cache control
  fetched_at                  timestamptz NOT NULL DEFAULT now(),
  last_validated_at           timestamptz NOT NULL DEFAULT now(), -- ultima revalidacao
  expires_at                  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_prices_cat
  ON ml_listing_prices_cache(ml_category_id, listing_type_id);
CREATE INDEX IF NOT EXISTS idx_listing_prices_expires
  ON ml_listing_prices_cache(expires_at);

-- ─── 4. ml_campaigns_summary (1 row por org+seller) ──────────
-- Atualizado pelo sync — alimenta dashboard executivo.
CREATE TABLE IF NOT EXISTS ml_campaigns_summary (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,

  -- Campanhas
  total_active_campaigns      integer DEFAULT 0,
  total_pending_campaigns     integer DEFAULT 0,
  total_ending_today          integer DEFAULT 0,
  total_ending_this_week      integer DEFAULT 0,

  -- Items
  total_candidate_items       integer DEFAULT 0,
  total_pending_items         integer DEFAULT 0,
  total_participating_items   integer DEFAULT 0,

  -- Health
  items_missing_cost          integer DEFAULT 0,
  items_missing_tax           integer DEFAULT 0,
  items_health_ok             integer DEFAULT 0,

  -- Recomendacoes IA (preenchido por Camada 2)
  total_recommended           integer DEFAULT 0,
  total_review                integer DEFAULT 0,
  total_skip                  integer DEFAULT 0,
  total_clearance_opportunities integer DEFAULT 0,

  -- Subsidio total disponivel (R$)
  total_meli_subsidy_available numeric DEFAULT 0,
  total_revenue_potential     numeric DEFAULT 0,
  total_margin_potential      numeric DEFAULT 0,

  -- Risco
  items_negative_margin       integer DEFAULT 0,
  items_below_min_margin      integer DEFAULT 0,

  -- Sync
  last_sync_at                timestamptz,
  next_sync_at                timestamptz,
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_camp_summary_org
  ON ml_campaigns_summary(organization_id);

-- ─── 5. ml_campaigns_sync_logs (auditoria de syncs) ──────────
CREATE TABLE IF NOT EXISTS ml_campaigns_sync_logs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint,                -- null = fan-out

  sync_type                   text NOT NULL CHECK (sync_type IN (
    'campaigns_list',     -- listar campanhas
    'campaign_items',     -- itens de 1 campanha
    'item_promotions',    -- promocoes de 1 item
    'subsidy_enrich',     -- Fase B: enriquecer candidates com subsidio
    'listing_prices',     -- cache de listing prices
    'full',               -- sync completo
    'webhook_event'       -- nao usado em v1, mantido pra futuro
  )),

  campaigns_processed         integer DEFAULT 0,
  items_processed             integer DEFAULT 0,
  items_subsidy_enriched      integer DEFAULT 0,
  api_calls_count             integer DEFAULT 0,
  pages_fetched               integer DEFAULT 0,

  status                      text NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'failed', 'partial'
  )),
  error_message               text,
  duration_seconds            integer,

  started_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ml_camp_sync_logs_org_seller
  ON ml_campaigns_sync_logs(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_ml_camp_sync_logs_status
  ON ml_campaigns_sync_logs(status, started_at DESC);

-- ─── Triggers: auto-update updated_at ─────────────────────────
CREATE OR REPLACE FUNCTION ml_campaigns_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ml_camp_updated ON ml_campaigns;
CREATE TRIGGER trg_ml_camp_updated
  BEFORE UPDATE ON ml_campaigns
  FOR EACH ROW EXECUTE FUNCTION ml_campaigns_touch_updated_at();

DROP TRIGGER IF EXISTS trg_ml_camp_items_updated ON ml_campaign_items;
CREATE TRIGGER trg_ml_camp_items_updated
  BEFORE UPDATE ON ml_campaign_items
  FOR EACH ROW EXECUTE FUNCTION ml_campaigns_touch_updated_at();

-- ─── GRANTs (mesmo padrao das outras migrations F7) ──────────
DO $$
DECLARE
  tbl text;
  affected_tables text[] := ARRAY[
    'ml_campaigns',
    'ml_campaign_items',
    'ml_listing_prices_cache',
    'ml_campaigns_summary',
    'ml_campaigns_sync_logs'
  ];
BEGIN
  FOREACH tbl IN ARRAY affected_tables LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;
