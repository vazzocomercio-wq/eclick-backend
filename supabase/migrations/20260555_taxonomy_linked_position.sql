-- ============================================
-- F6 Sprint 2 — Patch 2 (UX position labels)
-- Permite linkar uma opção de taxonomy (ambient) a uma das 11 posições da esteira.
--   - linked_position NULL = sem link (ambient disponível só como metadado da ref)
--   - linked_position 1..11 = posição ganha o nome desse ambient nos botões da UI
--   - Constraint: só kind='ambient' pode ter linked_position
--   - UNIQUE parcial: 1 ambient por (org_id, position) — não dá pra ter dois nomes
--     na mesma posição da mesma org. Defaults globais (org=NULL) começam todos
--     sem link (decisão do user — cada org configura pro nicho).
-- ============================================

ALTER TABLE public.creative_taxonomy_options
  ADD COLUMN IF NOT EXISTS linked_position int;

-- Range 1..11 ou NULL
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_taxonomy_linked_position_range'
  ) THEN
    ALTER TABLE public.creative_taxonomy_options
      ADD CONSTRAINT ck_taxonomy_linked_position_range
      CHECK (linked_position IS NULL OR (linked_position BETWEEN 1 AND 11));
  END IF;
END $$;

-- Só ambient pode linkar a posição
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_taxonomy_linked_position_only_ambient'
  ) THEN
    ALTER TABLE public.creative_taxonomy_options
      ADD CONSTRAINT ck_taxonomy_linked_position_only_ambient
      CHECK (linked_position IS NULL OR kind = 'ambient');
  END IF;
END $$;

-- Max 1 ambient por (org_normalizada, position).
-- Namespaces separados: defaults globais (org=NULL → uuid 'zero') vs cada org.
-- Significa que NA UI a query da org só vê ambient da própria org pra renderizar
-- labels — defaults globais ficariam invisíveis como label (decisão consciente).
CREATE UNIQUE INDEX IF NOT EXISTS ux_taxonomy_position_per_org
  ON public.creative_taxonomy_options (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    linked_position
  )
  WHERE linked_position IS NOT NULL AND kind = 'ambient';
