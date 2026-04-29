-- Sprint ENRICH-HUB-1 — painel unificado /dashboard/enriquecimento que
-- substitui /dashboard/lead-bridge + /dashboard/configuracoes/enrichment.
--
-- Adiciona 2 colunas de config global por org (toggle de enrichment
-- automático no journey-processor, e delay antes de mandar mensagem
-- pós-enrichment), e cria índice único pra upsert do template
-- pós-enrichment via template_kind (em vez de criar uma tabela nova).
--
-- Rollback:
--   ALTER TABLE organizations DROP COLUMN IF EXISTS auto_enrichment_enabled;
--   ALTER TABLE organizations DROP COLUMN IF EXISTS post_enrich_delay_minutes;
--   DROP INDEX IF EXISTS messaging_templates_org_kind_uq;

BEGIN;

-- ── 1. organizations — toggle e delay do enrichment automático ───────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_enrichment_enabled  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS post_enrich_delay_minutes integer NOT NULL DEFAULT 5;

COMMENT ON COLUMN organizations.auto_enrichment_enabled IS
  'Quando false, journey-processor.processOne() pula a chamada de enrichment.enrich()';
COMMENT ON COLUMN organizations.post_enrich_delay_minutes IS
  'Delay (jitter humano) em minutos antes de enviar template post_enrichment_welcome após enrichment com sucesso';

-- ── 2. messaging_templates — único por (org, template_kind) p/ upsert ────
-- Permite localizar o template "post_enrichment_welcome" sem busca por
-- name (resistente a renomeação pelo usuário). Único parcial: NULL
-- template_kind continua aceitando múltiplos rows.
CREATE UNIQUE INDEX IF NOT EXISTS messaging_templates_org_kind_uq
  ON messaging_templates (organization_id, template_kind)
  WHERE template_kind IS NOT NULL;

COMMIT;
