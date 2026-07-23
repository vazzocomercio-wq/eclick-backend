-- Radar de Encaixe (opportunities) — descobrir acessórios 3D úteis pra
-- produtos de grande circulação (hospedeiros) a partir de DOR REAL nas
-- avaliações. Fluxo: adotar hospedeiro → puxar reviews → minerar dores
-- (IA, com citação literal) → conceito + placar 0-5 × 10 critérios.

-- ── Hospedeiro: o produto de grande venda que o acessório vai servir ────────
CREATE TABLE IF NOT EXISTS public.opp_host (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id),
  platform         text NOT NULL DEFAULT 'mercado_livre',
  -- anúncio âncora (reviews moram no ITEM, não no catálogo)
  anchor_item_id   text NOT NULL,
  -- anúncios irmãos do mesmo produto (mais reviews da mesma dor)
  item_ids         text[] NOT NULL DEFAULT '{}',
  catalog_product_id text,
  title            text,
  brand            text,
  thumbnail        text,
  url              text,
  price_cents      integer,
  category_name    text,
  -- fotografia das avaliações no momento do fetch
  reviews_total    integer NOT NULL DEFAULT 0,
  reviews_fetched  integer NOT NULL DEFAULT 0,
  rating_average   numeric,
  rating_levels    jsonb,
  status           text NOT NULL DEFAULT 'ativo',   -- ativo | arquivado
  source           text NOT NULL DEFAULT 'manual',  -- manual | trends
  notes            text,
  reviews_fetched_at timestamptz,
  mined_at         timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform, anchor_item_id)
);
CREATE INDEX IF NOT EXISTS idx_opp_host_org ON public.opp_host (organization_id, status);

-- ── Cache das avaliações puxadas (evidência bruta) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.opp_review (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id),
  host_id          uuid NOT NULL REFERENCES public.opp_host(id) ON DELETE CASCADE,
  item_id          text NOT NULL,
  external_id      text NOT NULL,              -- id da review no ML
  rate             integer NOT NULL,
  title            text,
  content          text,
  likes            integer NOT NULL DEFAULT 0,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, host_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_opp_review_host ON public.opp_review (organization_id, host_id, rate);

-- ── Dor extraída pela IA (com citações literais) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.opp_pain (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id),
  host_id          uuid NOT NULL REFERENCES public.opp_host(id) ON DELETE CASCADE,
  -- dor = ≥3 citações reais; hipotese = menos que isso (não vira conceito direto)
  kind             text NOT NULL DEFAULT 'hipotese',  -- dor | hipotese
  label            text NOT NULL,                     -- curto: "não tem onde guardar os acessórios"
  description      text,
  quote_count      integer NOT NULL DEFAULT 0,
  -- [{review_id, rate, excerpt}] — frase LITERAL do consumidor
  quotes           jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence       numeric,                           -- 0-1 (auto-relato da IA)
  ai_model         text,
  status           text NOT NULL DEFAULT 'nova',      -- nova | validando | descartada | virou_conceito
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opp_pain_host ON public.opp_pain (organization_id, host_id, status);

-- ── Conceito de acessório + placar (F3, schema já pronto) ───────────────────
CREATE TABLE IF NOT EXISTS public.opp_concept (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id),
  host_id          uuid NOT NULL REFERENCES public.opp_host(id) ON DELETE CASCADE,
  pain_id          uuid REFERENCES public.opp_pain(id) ON DELETE SET NULL,
  name             text NOT NULL,
  summary          text,
  how_it_works     text,
  dimensions       text,
  fixation         text,          -- apoiado | encaixado | adesivo | parafusado
  material         text,          -- PLA | PETG (matriz de material Vazzo)
  print_notes      text,
  risk_flags       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- {usuarios, frequencia, ausencia_solucao, impressao, material_baixo,
  --  instalacao, compatibilidade, valor_percebido, demonstravel, risco_baixo}
  scores           jsonb NOT NULL DEFAULT '{}'::jsonb,
  score_total      integer,
  verdict          text,          -- prototipar (≥38) | reformular (30-37) | descartar (<30)
  gap_status       text,          -- inexistente | existe_ruim | saturado (F2)
  status           text NOT NULL DEFAULT 'novo',  -- novo | validando | aprovado | virou_produto | descartado
  product_dev_id   uuid,          -- vínculo quando promovido pro Product OS
  ai_model         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opp_concept_host ON public.opp_concept (organization_id, host_id, status);

-- ── GRANTs (tabela criada via _admin_exec_sql não herda defaults — §J) ──────
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['opp_host','opp_review','opp_pain','opp_concept'] LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;
