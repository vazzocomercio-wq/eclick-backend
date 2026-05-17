-- ════════════════════════════════════════════════════════════════════════════
-- e-Click Radar IA — C1 · Concorrentes Vinculados (fundação de dados)
-- ════════════════════════════════════════════════════════════════════════════
--
-- A segunda metade do Radar. O Radar de catálogo (20260573) cobre produtos de
-- catálogo ML — onde /products/{id}/items entrega o conjunto competitivo de
-- graça. Mas a maioria dos anúncios NÃO é catálogo; pra esses o ML não diz
-- quem concorre. Aqui o vendedor VINCULA manualmente: "meu produto X concorre
-- com estes anúncios de concorrente".
--
-- Restrições reais (spike C0, 2026-05-17):
--   • Preço do concorrente — API /items/{id} dá 403 (PolicyAgent), multi-get
--     idem, /sites/MLB/search 403, e a página pública devolve só uma casca de
--     ~9KB renderizada por JS. Logo: PREÇO É INFORMADO PELO USUÁRIO.
--     `price_source` nasce preparado pra 'extension' (extensão Chrome F12)
--     virar a fonte automática depois, sem retrabalho.
--   • Visitas — /items/{id}/visits/time_window FUNCIONA pra item de terceiro.
--     É o sinal de demanda automático do módulo.
--   • Reputação do vendedor — depende do seller_id, que vem de dentro do item
--     (403). Só populada quando o id do vendedor for conhecido por outra via.
--
-- Princípios (não-negociáveis): multi-tenant (organization_id + RLS),
-- multi-conta, multi-marketplace (coluna `platform`).
--
-- NÃO altera nenhuma tabela já em produção — `radar_sellers` é reaproveitada
-- apenas por INSERT.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 1. radar_competitor_links — o vínculo produto ↔ anúncio concorrente ─────
CREATE TABLE IF NOT EXISTS public.radar_competitor_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform              text NOT NULL DEFAULT 'mercadolivre',
  product_id            uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
                                                          -- NOSSO produto (âncora da comparação)
  competitor_item_id    text NOT NULL,                    -- MLB... do anúncio concorrente
  competitor_url        text,                             -- URL canônica do anúncio
  competitor_title      text,                             -- preenchido pela coleta (casca SEO)
  competitor_thumbnail  text,
  competitor_seller_id  bigint,                           -- id ML do vendedor — quando conhecido
  competitor_seller_ref uuid REFERENCES public.radar_sellers(id) ON DELETE SET NULL,
  label                 text,                             -- apelido livre dado pelo vendedor
  current_price         numeric,                          -- preço atual informado pelo usuário
  price_source          text NOT NULL DEFAULT 'manual'
                          CHECK (price_source IN ('manual', 'extension', 'scrape', 'api')),
  price_updated_at      timestamptz,
  status                text NOT NULL DEFAULT 'ativo'
                          CHECK (status IN ('ativo', 'pausado')),
  created_by            uuid,                             -- user que criou o vínculo
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radar_competitor_links_uniq
    UNIQUE (organization_id, platform, product_id, competitor_item_id)
);
CREATE INDEX IF NOT EXISTS idx_radar_competitor_links_org_status
  ON public.radar_competitor_links (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_radar_competitor_links_product
  ON public.radar_competitor_links (organization_id, product_id);

GRANT ALL ON TABLE public.radar_competitor_links TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_competitor_links TO authenticated;
ALTER TABLE public.radar_competitor_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_competitor_links_org ON public.radar_competitor_links
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));


-- ─── 2. radar_competitor_snapshots — histórico diário unificado ──────────────
-- Uma linha por anúncio por dia. `link_id` NULL = linha do NOSSO anúncio;
-- preenchido = concorrente. Agrupado por `product_id` — uma só query devolve
-- a comparação inteira (nosso anúncio + todos os concorrentes, ao longo do
-- tempo). Volume baixo (só produtos monitorados) — sem particionamento.
CREATE TABLE IF NOT EXISTS public.radar_competitor_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  link_id          uuid REFERENCES public.radar_competitor_links(id) ON DELETE CASCADE,
                                                          -- NULL = nosso anúncio
  item_id          text NOT NULL,                        -- MLB (nosso ou do concorrente)
  snapshot_date    date NOT NULL DEFAULT CURRENT_DATE,
  price            numeric,                              -- preço daquele dia (carry-forward na leitura)
  price_source     text,
  visits           int,                                  -- visitas do dia (sinal de demanda)
  collected_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radar_competitor_snapshots_uniq
    UNIQUE (organization_id, item_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_radar_competitor_snapshots_product
  ON public.radar_competitor_snapshots (organization_id, product_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_radar_competitor_snapshots_link
  ON public.radar_competitor_snapshots (link_id, snapshot_date DESC);

GRANT ALL ON TABLE public.radar_competitor_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_competitor_snapshots TO authenticated;
ALTER TABLE public.radar_competitor_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_competitor_snapshots_org ON public.radar_competitor_snapshots
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));


COMMENT ON TABLE public.radar_competitor_links IS
  'e-Click Radar IA C1 — vínculo manual produto próprio ↔ anúncio concorrente (não-catálogo). Preço informado pelo usuário (price_source pronto pra extensão Chrome).';
COMMENT ON TABLE public.radar_competitor_snapshots IS
  'e-Click Radar IA C1 — histórico diário unificado (preço + visitas) de anúncios monitorados. link_id NULL = anúncio próprio; preenchido = concorrente.';
