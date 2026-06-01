-- ═══════════════════════════════════════════════════════════════════
-- 20260688 — ML Ads NÍVEL-ANÚNCIO (F12 ML Fase 4, copiloto)
--
-- Snapshot por ANÚNCIO (item) do Product Ads do ML. O motor do Ads Agent
-- (Active) decide no nível de anúncio (pausar/remover anúncio ruim dentro de
-- campanha; impulsionar item recomendado/orgânico forte) além de campanha.
--
-- Fonte: GET /advertising/{SITE}/advertisers/{ADV}/product_ads/items/search
-- (api-version 2) — o MESMO endpoint que getPadsMetrics já usa, mas aqui
-- guardamos os campos POR ITEM (status, recommended, permalink, métricas
-- agregadas da janela) em vez de só agregar por campanha.
--
-- ⚠️ Escrita no Product Ads do ML está BLOQUEADA (401 mclics — falta o Mercado
-- Ads liberar). Esta tabela é só LEITURA/decisão: o Active sugere (card +
-- deep-link), o usuário aplica manual no painel. Nenhum write daqui.
--
-- Multi-tenant: mesma convenção de ml_ads_campaigns (RLS por org via
-- organization_members + GRANT ALL ao service_role, que bypassa RLS no sync).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ml_ads_items (
  organization_id uuid        NOT NULL,
  item_id         text        NOT NULL,             -- MLBxxxxxxxxx
  advertiser_id   text,
  campaign_id     text,                             -- campanha dona do anúncio (0/null se fora)
  ad_group_id     text,
  title           text,
  price           numeric,
  permalink       text,                             -- link público do anúncio
  thumbnail       text,
  status          text,                             -- ML: active|paused|hold|idle|...
  recommended     boolean,                          -- ML já considera o item bom p/ anunciar
  domain_id       text,
  -- métricas AGREGADAS da janela (últimos metrics_days dias do items/search):
  clicks          numeric,
  prints          numeric,
  cost            numeric,                           -- gasto (R$)
  units_quantity  numeric,                           -- vendas atribuídas
  total_amount    numeric,                           -- receita atribuída (R$)
  acos            numeric,                           -- gasto÷receita (%)
  roas            numeric,
  ctr             numeric,
  metrics_days    int,                               -- tamanho da janela usada
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_ads_items_campaign
  ON public.ml_ads_items (organization_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_ml_ads_items_status
  ON public.ml_ads_items (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_ml_ads_items_advertiser
  ON public.ml_ads_items (organization_id, advertiser_id);

-- RLS — mesma política das demais tabelas ml_ads_* (20260505).
ALTER TABLE public.ml_ads_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ml_ads_items_org ON public.ml_ads_items;
CREATE POLICY ml_ads_items_org ON public.ml_ads_items FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- service_role bypassa RLS (sync escreve, bridge do Active lê).
GRANT ALL ON public.ml_ads_items TO service_role;
