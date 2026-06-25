-- ============================================================
-- Product OS — proveniência de importação (MakerWorld / catálogos externos)
-- Peça 1 do épico MakerWorld: importar por URL → produto. Guarda a origem e a
-- LICENÇA de forma estruturada pra que a Peça 2 (porteiro de licença) leia
-- direto, sem reparsing. Aditivo: 5 colunas em product_dev, RLS/grants herdados.
--   source_platform        — 'makerworld' | 'thingiverse' | … (NULL = criado à mão)
--   source_external_id     — id do design na plataforma de origem
--   source_license         — código de licença bruto da origem (ex 'BY-NC-SA')
--   source_allow_recreation— flag da origem: permite recriar/derivar? (landmine)
--   source_metadata        — snapshot bruto (criador, downloads, originals/remix…)
-- ============================================================
ALTER TABLE product_dev
  ADD COLUMN IF NOT EXISTS source_platform         TEXT,
  ADD COLUMN IF NOT EXISTS source_external_id      TEXT,
  ADD COLUMN IF NOT EXISTS source_license          TEXT,
  ADD COLUMN IF NOT EXISTS source_allow_recreation BOOLEAN,
  ADD COLUMN IF NOT EXISTS source_metadata         JSONB NOT NULL DEFAULT '{}'::jsonb;

-- evita reimportar o mesmo design 2x na mesma org (índice parcial; NULLs livres)
CREATE INDEX IF NOT EXISTS idx_product_dev_source
  ON product_dev (organization_id, source_platform, source_external_id)
  WHERE source_platform IS NOT NULL;
