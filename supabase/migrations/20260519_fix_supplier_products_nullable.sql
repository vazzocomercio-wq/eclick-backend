-- ════════════════════════════════════════════════════════════════════════
-- HOTFIX — supplier_products: tornar colunas operacionais nullable
-- ════════════════════════════════════════════════════════════════════════
-- Sintoma: ao adicionar produto dropship via UI, backend reportava
-- 'null value in column "lead_time_days" of relation "supplier_products"
--  violates not-null constraint'.
--
-- Causa: alguma migration anterior adicionou NOT NULL em colunas
-- operacionais que podem perfeitamente ser desconhecidas no momento
-- do cadastro inicial (parceiro pode preencher depois). Os tipos TS
-- já tratam essas colunas como nullable, então o backend confiava
-- em DEFAULT do banco.
--
-- Fix dual:
--  1. Backend (TypeScript) agora passa defaults sensatos quando o
--     usuário não fornecer (lead_time=1, safety=0, moq=1).
--  2. DB: DROP NOT NULL nas colunas afetadas pra suportar parceiros
--     com configuração mínima (sem todos os defaults).
-- ════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- lead_time_days
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='supplier_products'
      AND column_name='lead_time_days' AND is_nullable='NO'
  ) THEN
    ALTER TABLE supplier_products ALTER COLUMN lead_time_days DROP NOT NULL;
  END IF;

  -- safety_days
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='supplier_products'
      AND column_name='safety_days' AND is_nullable='NO'
  ) THEN
    ALTER TABLE supplier_products ALTER COLUMN safety_days DROP NOT NULL;
  END IF;

  -- moq
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='supplier_products'
      AND column_name='moq' AND is_nullable='NO'
  ) THEN
    ALTER TABLE supplier_products ALTER COLUMN moq DROP NOT NULL;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
