-- ============================================================
-- Product OS — T1-C: prazo de entrega por ordem de produção
--
-- Prazo OPCIONAL por ordem. O scheduler de capacidade finita calcula o ETA
-- (quando cada ordem fica pronta) e, havendo prazo, marca as que vão atrasar.
-- 100% aditivo.
-- ============================================================
ALTER TABLE production_order
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
