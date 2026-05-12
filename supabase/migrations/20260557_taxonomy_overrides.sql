-- ============================================
-- F6 Sprint 2 — Patch 4 (clone-on-modify para defaults)
-- User pediu poder linkar/editar opções padrão. Defaults globais são
-- compartilhados entre orgs (UPDATE direto quebraria cross-org).
-- Solução: clone-on-modify — quando uma org tenta editar um default,
-- backend cria uma cópia org-owned com as mudanças, e a default original
-- fica filtrada da lista dessa org (sobrescrita).
-- ============================================

ALTER TABLE public.creative_taxonomy_options
  ADD COLUMN IF NOT EXISTS overrides_default_id uuid;

-- FK pro default original (SET NULL se default sumir; cascata seria estranho)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_taxonomy_overrides_default'
  ) THEN
    ALTER TABLE public.creative_taxonomy_options
      ADD CONSTRAINT fk_taxonomy_overrides_default
      FOREIGN KEY (overrides_default_id)
      REFERENCES public.creative_taxonomy_options(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 1 override por (org, default) — não pode ter 2 cópias da mesma default
CREATE UNIQUE INDEX IF NOT EXISTS ux_taxonomy_override_per_org
  ON public.creative_taxonomy_options (organization_id, overrides_default_id)
  WHERE overrides_default_id IS NOT NULL;

-- Só rows org-owned não-default podem sobrescrever defaults
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_taxonomy_override_shape'
  ) THEN
    ALTER TABLE public.creative_taxonomy_options
      ADD CONSTRAINT ck_taxonomy_override_shape
      CHECK (
        overrides_default_id IS NULL
        OR (organization_id IS NOT NULL AND is_default = false)
      );
  END IF;
END $$;
