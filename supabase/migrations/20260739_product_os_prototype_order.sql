-- ============================================================
-- Product OS — ordem de protótipo vs produção
-- Protótipo (projeto sem produto cadastrado): consome insumo, NÃO credita
-- estoque vendável. Produção (produto cadastrado): consome insumo + credita
-- products.stock (nativo, sem Icarus). Aditivo: 1 coluna.
-- ============================================================
ALTER TABLE production_order
  ADD COLUMN IF NOT EXISTS is_prototype BOOLEAN NOT NULL DEFAULT false;
