-- ============================================
-- F11 Fase 2 — Migration 2/3
-- Flex Status: extensão pra elegível vs ativo (Caminho A)
--
-- ml_flex_status já existe (Sprint 3 / E3 Logística) com 243 rows do Vazzo.
-- Caminho A escolhido: ALTER ADD COLUMN preservando dados existentes.
--
-- Semântica reinterpretada:
--   has_flex (existente) = is_eligible (item tem self_service_in em shipping.tags
--                          OU coverage em /flex/sites/MLB/items/{id}/v2)
--   is_active (novo)     = vendedor efetivamente aderiu ao Flex (≠ elegibilidade)
--
-- Estado atual (não snapshot histórico): 1 row por item, UNIQUE
-- (org, seller, ml_item_id) já existente. Adequado pra leaderboard
-- "elegível mas não ativado".
-- ============================================

-- ALTER: novas colunas ──────────────────────────────────────────────
ALTER TABLE public.ml_flex_status
  ADD COLUMN IF NOT EXISTS is_active        boolean,           -- vendedor aderiu ao Flex?
  ADD COLUMN IF NOT EXISTS coverage_pct     numeric(5,2),      -- % CEPs cobertos na região
  ADD COLUMN IF NOT EXISTS coverage_zips    integer,           -- nº CEPs cobertos (auditoria)
  ADD COLUMN IF NOT EXISTS shipping_tags    text[],            -- raw tags do /items/{id}
  ADD COLUMN IF NOT EXISTS last_checked_at  timestamptz;       -- última verificação Flex API

-- Comments semânticos ───────────────────────────────────────────────
COMMENT ON COLUMN public.ml_flex_status.has_flex IS
  'DEPRECATED nomenclatura. Representa is_eligible: item elegível ao Flex (tem self_service_in em shipping.tags). Manter pra retrocompat até migração F11.2.x consolidada.';

COMMENT ON COLUMN public.ml_flex_status.is_active IS
  'Vendedor efetivamente aderiu ao Flex (≠ elegibilidade). NULL = ainda não verificado.';

COMMENT ON COLUMN public.ml_flex_status.coverage_pct IS
  '% de CEPs cobertos pela política Flex do vendedor para esse item.';

-- VIEW: leaderboard "elegível mas não ativado" ─────────────────────
CREATE OR REPLACE VIEW public.v_flex_opportunity AS
SELECT
  f.organization_id,
  f.seller_id,
  f.ml_item_id,
  f.product_id,
  f.has_flex          AS is_eligible,
  f.is_active,
  f.coverage_pct,
  f.last_checked_at,
  CASE
    WHEN f.has_flex = true AND COALESCE(f.is_active, false) = false
      THEN 'opportunity'
    WHEN f.has_flex = true AND f.is_active = true
      THEN 'active'
    WHEN f.has_flex = false
      THEN 'not_eligible'
    ELSE 'unknown'
  END AS flex_state
FROM public.ml_flex_status f;

COMMENT ON VIEW public.v_flex_opportunity IS
  'F11 Fase 2: classifica cada item como opportunity (elegível não ativado), active, not_eligible. Card "Oportunidades Flex" no dashboard executivo consome essa view.';

-- INDEXES pra leaderboard ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ix_ml_flex_org_active
  ON public.ml_flex_status (organization_id, is_active)
  WHERE has_flex = true;

CREATE INDEX IF NOT EXISTS ix_ml_flex_org_checked
  ON public.ml_flex_status (organization_id, last_checked_at);

-- GRANTs explícitos (feedback_grant_admin_exec_sql)
GRANT SELECT ON public.v_flex_opportunity TO service_role;
GRANT SELECT ON public.v_flex_opportunity TO authenticated;
