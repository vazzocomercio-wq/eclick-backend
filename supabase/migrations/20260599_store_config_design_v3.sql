-- Store Builder v3 — receita de design com secoes e blocos.
--
-- Adiciona a coluna `design_v3` em store_config. Guarda a receita v3 (5
-- paginas, globals header/footer, secoes com blocos internos, mobile
-- overrides). Aditiva: a coluna `design` (v2) continua viva. NULL aqui =
-- a loja ainda usa o design v2.
--
-- O renderer escolhe: design_v3 nao-nulo => v3; senao => fallback v2.
-- Quando todas as lojas migrarem, dropa-se `design` em uma sprint dedicada.
--
-- ADD COLUMN herda os grants da tabela existente.

ALTER TABLE store_config
  ADD COLUMN IF NOT EXISTS design_v3 jsonb;

COMMENT ON COLUMN store_config.design_v3 IS
  'Receita de design v3 (Store Builder — Section+Blocks). NULL = loja usa design v2 (coluna design).';
