-- Conta dedicada vs mista no vínculo conta→fornecedor do dropship.
--  - dedicated=true (default): a conta vende SÓ do(s) parceiro(s) vinculado(s).
--    Produto fora do catálogo vira on_hold ("rever catálogo" = lista de cadastro).
--  - dedicated=false (mista): a conta também vende estoque próprio. Produto fora
--    do catálogo de qualquer parceiro é ignorado (não vira on_hold).
--
-- Default true preserva o comportamento atual (todas as contas hoje são
-- dedicadas à Cinderella). Permite, no futuro, marcar uma conta como
-- compartilhada/mista. Aditiva, idempotente.

ALTER TABLE seller_account_suppliers
  ADD COLUMN IF NOT EXISTS dedicated boolean NOT NULL DEFAULT true;
