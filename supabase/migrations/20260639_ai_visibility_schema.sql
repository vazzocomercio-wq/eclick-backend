-- AI Visibility OS — Fase 1 (setup): schema base.
--
-- GEO (Generative Engine Optimization): medir e melhorar o quanto os produtos
-- e o conteúdo da org aparecem/são citados pelos motores de IA (ChatGPT,
-- Perplexity, Gemini, Google AI Overviews). É "SEO para buscadores de IA".
--
-- NÃO confundir com:
--   - e-otimizer  → busca interna do Mercado Livre
--   - radar       → inteligência de mercado/concorrentes no ML
-- Aqui o alvo são os motores de IA EXTERNOS.
--
-- Multi-tenant: toda tabela carrega org_id e é escopada por organização.
-- Leitura passa pelo backend (service_role) com filtro de org via JWT —
-- por isso GRANT só pra service_role + RLS habilitado (default-deny) como
-- defesa em profundidade. O frontend NUNCA lê estas tabelas direto.

-- ============================================================
-- JOBS DE AUDITORIA — uma rodada de auditoria de uma URL num motor de IA
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_audit_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id    uuid,                                  -- opcional: products.id (ref lógica)
  url           text NOT NULL,                         -- página/produto auditado
  platform      varchar(30) NOT NULL,                  -- chatgpt|perplexity|gemini|google_ai_overview|copilot
  status        varchar(20) NOT NULL DEFAULT 'pending',-- pending|running|completed|failed
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_avj_org_status_time ON public.ai_audit_jobs (org_id, status, created_at DESC);

COMMENT ON TABLE public.ai_audit_jobs IS
  'Rodadas de auditoria GEO: avalia uma URL num motor de IA (status do processamento).';

-- ============================================================
-- RESULTADOS — saída de um job (score + detalhamento + recomendações)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_audit_results (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               uuid NOT NULL REFERENCES public.ai_audit_jobs(id) ON DELETE CASCADE,
  org_id               uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE, -- denormalizado p/ escopo
  geo_score            numeric(5,2),                        -- 0-100
  breakdown_json       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- score por dimensão
  recommendations_json jsonb NOT NULL DEFAULT '[]'::jsonb,   -- lista de recomendações
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_avr_job        ON public.ai_audit_results (job_id);
CREATE INDEX IF NOT EXISTS idx_avr_org_time   ON public.ai_audit_results (org_id, created_at DESC);

COMMENT ON TABLE public.ai_audit_results IS
  'Resultado de um job de auditoria: geo_score 0-100 + breakdown por dimensão + recomendações.';

-- ============================================================
-- RUBRICA DE PONTUAÇÃO — dimensões e pesos do geo_score
-- org_id null = padrão da plataforma; org pode sobrescrever no futuro.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_score_breakdown (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid REFERENCES public.organizations(id) ON DELETE CASCADE, -- null = default da plataforma
  dimension    varchar(60) NOT NULL,                  -- chave canônica da dimensão
  label        text NOT NULL,
  weight       numeric(5,2) NOT NULL DEFAULT 1,        -- peso relativo na nota
  description  text,
  sort_order   integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Unicidade: 1 default de plataforma por dimensão + 1 override por org/dimensão.
CREATE UNIQUE INDEX IF NOT EXISTS uq_asb_platform_dim ON public.ai_score_breakdown (dimension)        WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_asb_org_dim      ON public.ai_score_breakdown (org_id, dimension) WHERE org_id IS NOT NULL;

COMMENT ON TABLE public.ai_score_breakdown IS
  'Rubrica do geo_score: dimensões + pesos. org_id null = padrão da plataforma; override por org no futuro.';

-- ============================================================
-- PRODUTOS MONITORADOS — radar de visibilidade por produto
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tracked_products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id   uuid,                                  -- products.id (ref lógica)
  url          text,                                  -- URL monitorada (anúncio/loja)
  label        text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tp_org_active ON public.tracked_products (org_id, active);

COMMENT ON TABLE public.tracked_products IS
  'Produtos que a org monitora no radar de visibilidade em IA.';

-- ============================================================
-- QUERIES MONITORADAS — perguntas a observar nos motores de IA
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tracked_queries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  query        text NOT NULL,                         -- ex: "melhor arandela de cristal"
  platform     varchar(30),                           -- motor específico; null = todos
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tq_org_active ON public.tracked_queries (org_id, active);

COMMENT ON TABLE public.tracked_queries IS
  'Queries que a org quer monitorar: se/como seus produtos aparecem nas respostas de IA.';

-- ============================================================
-- SEED — rubrica padrão da plataforma (idempotente: só insere se vazia)
-- ============================================================
INSERT INTO public.ai_score_breakdown (org_id, dimension, label, weight, description, sort_order)
SELECT v.org_id, v.dimension, v.label, v.weight, v.description, v.sort_order
FROM (VALUES
  (NULL::uuid, 'structured_data',    'Dados estruturados',     20::numeric, 'Schema.org / JSON-LD que ajuda a IA a entender o produto', 1),
  (NULL::uuid, 'content_clarity',    'Clareza do conteúdo',    20::numeric, 'Descrição factual, objetiva e em formato de resposta',    2),
  (NULL::uuid, 'citations_mentions', 'Citações e menções',     20::numeric, 'Quantas fontes externas citam o produto/marca',           3),
  (NULL::uuid, 'entity_authority',   'Autoridade da marca',    15::numeric, 'Reconhecimento da marca/entidade pelos modelos de IA',    4),
  (NULL::uuid, 'direct_answer',      'Resposta direta / FAQ',  15::numeric, 'Conteúdo em formato pergunta-resposta',                   5),
  (NULL::uuid, 'freshness',          'Atualidade',             10::numeric, 'Recência e manutenção do conteúdo',                       6)
) AS v(org_id, dimension, label, weight, description, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.ai_score_breakdown WHERE org_id IS NULL);

-- ============================================================
-- RLS — default-deny pra authenticated (sem policy permissiva).
-- service_role bypassa RLS; é por ele que toda leitura passa (backend gated).
-- ============================================================
ALTER TABLE public.ai_audit_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_audit_results   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_score_breakdown ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_queries    ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- GRANTS — criação via _admin_exec_sql não herda default privileges.
-- Só service_role (backend). Frontend nunca consulta direto.
-- ============================================================
GRANT ALL ON TABLE public.ai_audit_jobs      TO service_role;
GRANT ALL ON TABLE public.ai_audit_results   TO service_role;
GRANT ALL ON TABLE public.ai_score_breakdown TO service_role;
GRANT ALL ON TABLE public.tracked_products   TO service_role;
GRANT ALL ON TABLE public.tracked_queries    TO service_role;
