-- Sprint F6 — IA Criativo (Entrega 3c F3: Publicação real no marketplace)
--
-- Tabela `creative_publications` rastreia toda publicação feita a partir
-- do módulo Creative pra qualquer marketplace. Snapshot completo do que
-- foi enviado + resposta do marketplace + status atual.
--
-- Idempotência: idempotency_key UUID gerado pela UI quando o user abre
-- o dialog de confirmação. Backend rejeita duplicatas — protege contra
-- duplo-clique e retries acidentais.
--
-- Rollback:
--   DROP TABLE IF EXISTS creative_publications;

CREATE TABLE IF NOT EXISTS creative_publications (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  listing_id             uuid NOT NULL REFERENCES creative_listings(id) ON DELETE CASCADE,
  product_id             uuid NOT NULL REFERENCES creative_products(id) ON DELETE CASCADE,
  user_id                uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  marketplace            text NOT NULL CHECK (marketplace IN (
    'mercado_livre', 'shopee', 'amazon', 'magalu'
  )),

  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',     -- criada, ainda não tentou publicar
    'publishing',  -- em andamento (uploads + POST)
    'published',   -- sucesso, MLB ID disponível em external_id
    'failed'       -- algo deu errado, error_message preenchido
  )),

  -- Idempotência: UI gera UUID quando abre dialog, manda no body. Mesma key
  -- = mesma publicação (não cria nova).
  idempotency_key        uuid NOT NULL,

  -- Snapshot do que foi/iria ser publicado (preserva mesmo se listing muda)
  image_ids              uuid[] NOT NULL DEFAULT '{}',
  video_id               uuid,
  category_id            text,
  listing_type           text,           -- free / gold_special / gold_pro
  condition              text,           -- new / used / not_specified
  price                  numeric(12,2),
  stock                  integer,
  attributes             jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload_sent           jsonb,          -- exato body que foi pro POST /items

  -- Identificadores externos retornados pelo marketplace
  external_id            text,           -- MLB-XXXXXXX
  external_url           text,           -- permalink
  external_picture_ids   text[] NOT NULL DEFAULT '{}',
  external_video_id      text,
  ml_response            jsonb,          -- response inteira pra debug

  -- Sync futuro (F4)
  last_synced_status     text,
  last_synced_at         timestamptz,

  error_message          text,

  published_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: única por org+marketplace+key
CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_publications_idempotency
  ON creative_publications(organization_id, marketplace, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_creative_publications_listing
  ON creative_publications(listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_publications_product
  ON creative_publications(product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creative_publications_org_status
  ON creative_publications(organization_id, status, created_at DESC);

-- Pra cron de sync (F4) — pega published que precisa re-checar
CREATE INDEX IF NOT EXISTS idx_creative_publications_sync
  ON creative_publications(last_synced_at NULLS FIRST)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_creative_publications_external
  ON creative_publications(marketplace, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE creative_publications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS creative_publications_org ON creative_publications;
CREATE POLICY creative_publications_org ON creative_publications FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));
GRANT ALL ON creative_publications TO service_role;
