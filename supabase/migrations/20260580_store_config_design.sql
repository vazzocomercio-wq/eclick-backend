-- Loja Propria — Designer com IA (Fase 1)
--
-- Adiciona a coluna `design` em store_config. Guarda a receita de design
-- da loja (StorefrontDesign em JSON): tema, blocos da home e layout da
-- pagina de produto. NULL = o renderer usa o modelo padrao.
--
-- Na Fase 2 a IA passa a preencher esta coluna a partir de um prompt +
-- modelo de inspiracao. ADD COLUMN herda os grants da tabela existente.

ALTER TABLE store_config
  ADD COLUMN IF NOT EXISTS design jsonb;

COMMENT ON COLUMN store_config.design IS
  'Receita de design da Loja Propria (StorefrontDesign). NULL = usa o modelo padrao no renderer.';
