-- ============================================================
-- ml_labels — cache de traducoes PT-BR vindas do ML
-- ============================================================
-- ML expoe nomes localizados via:
--   GET /domains/MLB-LIGHT_BULBS  →  { name: "Lampadas" }
--   GET /categories/{id}/attributes → cada attr tem name PT-BR
--
-- Em vez de consumir API toda hora, cacheamos com TTL de 30d
-- (esses nomes nunca mudam na pratica).
--
-- Compartilhado entre orgs — labels sao globais. Lookup por
-- (kind, ml_id) eh O(log n) com unique index.
-- ============================================================

CREATE TABLE IF NOT EXISTS ml_labels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('domain', 'attribute')),
  ml_id           text NOT NULL,
  name_pt         text NOT NULL,
  raw             jsonb,                      -- shape original do ML (pra debug)
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  UNIQUE (kind, ml_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_labels_lookup
  ON ml_labels(kind, ml_id);

CREATE INDEX IF NOT EXISTS idx_ml_labels_expires
  ON ml_labels(expires_at);

-- GRANTs (mesmo padrao do 20260528_fix_grants_ml_quality)
GRANT ALL ON TABLE public.ml_labels TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ml_labels TO authenticated;
