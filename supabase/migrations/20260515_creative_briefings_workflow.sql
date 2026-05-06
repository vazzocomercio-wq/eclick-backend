-- Sprint F6 — Workflow IA Criativo (Bloco 1: Schema)
--
-- Adiciona campos pro novo fluxo:
--   environments       — multi-select de ambientes (substitui environment single)
--   custom_prompt      — instrucao livre do user pra geracao
--   image_prompts      — base de 10 prompts img editaveis (NULL = gera on-demand)
--   video_prompts      — base de N prompts vid editaveis  (NULL = gera on-demand)
--
-- Backfill: environments populado a partir de environment quando existir.
-- Coluna environment fica deprecated (sem CHECK), backend para de escrever
-- nela. Drop em migration futura quando todos clientes tiverem migrado.
--
-- Tabela creative_briefing_templates ganha os mesmos campos pra paridade.
--
-- Rollback:
--   ALTER TABLE creative_briefings DROP COLUMN IF EXISTS environments;
--   ALTER TABLE creative_briefings DROP COLUMN IF EXISTS custom_prompt;
--   ALTER TABLE creative_briefings DROP COLUMN IF EXISTS image_prompts;
--   ALTER TABLE creative_briefings DROP COLUMN IF EXISTS video_prompts;
--   ALTER TABLE creative_briefing_templates DROP COLUMN IF EXISTS environments;
--   ALTER TABLE creative_briefing_templates DROP COLUMN IF EXISTS custom_prompt;
--   (CHECK constraint de environment nao e restaurada — accept any text)

-- 1. creative_briefings: novos campos
ALTER TABLE creative_briefings
  ADD COLUMN IF NOT EXISTS environments    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS custom_prompt   text,
  ADD COLUMN IF NOT EXISTS image_prompts   text[],
  ADD COLUMN IF NOT EXISTS video_prompts   text[];

-- 2. Backfill: environment single -> environments[]
UPDATE creative_briefings
   SET environments = ARRAY[environment]
 WHERE environment IS NOT NULL
   AND (environments IS NULL OR cardinality(environments) = 0);

-- 3. Drop CHECK constraint do environment (vai virar deprecated)
ALTER TABLE creative_briefings
  DROP CONSTRAINT IF EXISTS creative_briefings_environment_check;

-- 4. creative_briefing_templates: paridade
ALTER TABLE creative_briefing_templates
  ADD COLUMN IF NOT EXISTS environments  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS custom_prompt text;

UPDATE creative_briefing_templates
   SET environments = ARRAY[environment]
 WHERE environment IS NOT NULL
   AND (environments IS NULL OR cardinality(environments) = 0);
