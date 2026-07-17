-- ============================================================
-- Product OS — Tamanho como 2º eixo de variação do SKU
--
-- Antes: 1 modelo → N SKUs, variando SÓ em cor.   VZ-07010202-47
-- Agora: 1 modelo → N SKUs, variando cor × tamanho. VZ-07010202-47-G
--
-- Motivação: Pendente Gota G/M, Bacia G/M, Bola G/M são o MESMO produto num
-- só anúncio (o cliente escolhe o tamanho no dropdown), mas o Product OS só
-- sabia emitir uma linha por cor — forçando 1 projeto por tamanho, o que
-- duplica ficha, briefing e aprovação de uma coisa só.
--
-- 100% ADITIVO e retrocompatível: tamanho_id NULL = exatamente o comportamento
-- de hoje, e o SKU continua saindo `base-cor` (sem sufixo). Nenhum SKU já
-- publicado muda — o Master SKU é permanente.
-- ============================================================

-- (1) Tamanho é um kind de sku_taxonomy. Não há CHECK em sku_taxonomy.kind
--     (é TEXT livre, validado no TS), então nada a alterar no schema —
--     só documentamos o novo valor aceito.
COMMENT ON COLUMN sku_taxonomy.kind IS
  'marca | categoria | sub | linha | caracteristica | cor | tamanho — cor e tamanho são os eixos de variação (topo, sem pai)';

-- (2) Variante ganha o eixo tamanho + métricas próprias.
--     weight_g/print_time_minutes por variante existem porque o tamanho muda o
--     custo BRUTALMENTE (Pendente Gota G = 321g/25h vs M = 97g/8,4h). Sem isso
--     o custo por tamanho sai errado e o preço sugerido vai junto.
--     NULL = herda do projeto/versão (comportamento de hoje).
ALTER TABLE product_dev_sku_variant
  ADD COLUMN IF NOT EXISTS tamanho_id          UUID REFERENCES sku_taxonomy(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS weight_g            NUMERIC,
  ADD COLUMN IF NOT EXISTS print_time_minutes  INTEGER;

-- (3) A unicidade passa a ser (dev, cor, tamanho).
--     O índice antigo (dev, cor) IMPEDIA Vaso-Creme-G + Vaso-Creme-M.
--     COALESCE p/ o UUID zero porque em índice único do Postgres NULL != NULL
--     — sem isso, duas variantes sem tamanho na mesma cor passariam batido.
DROP INDEX IF EXISTS ux_pdsv_dev_cor;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdsv_dev_cor_tam ON product_dev_sku_variant
  (product_dev_id, cor_id, COALESCE(tamanho_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_pdsv_tamanho ON product_dev_sku_variant(tamanho_id);

-- Guarda-corpo: tamanho_id tem que apontar mesmo p/ um nó kind='tamanho'.
-- FK só garante que existe na sku_taxonomy, não que é do kind certo — sem isso
-- daria pra pendurar uma COR no eixo de tamanho e o SKU sairia mudo.
CREATE OR REPLACE FUNCTION public.assert_pdsv_axis_kinds() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sku_taxonomy WHERE id = NEW.cor_id AND kind = 'cor') THEN
    RAISE EXCEPTION 'cor_id % nao aponta para um no kind=cor', NEW.cor_id;
  END IF;
  IF NEW.tamanho_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sku_taxonomy WHERE id = NEW.tamanho_id AND kind = 'tamanho'
  ) THEN
    RAISE EXCEPTION 'tamanho_id % nao aponta para um no kind=tamanho', NEW.tamanho_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pdsv_axis_kinds ON product_dev_sku_variant;
CREATE TRIGGER trg_pdsv_axis_kinds
  BEFORE INSERT OR UPDATE OF cor_id, tamanho_id ON product_dev_sku_variant
  FOR EACH ROW EXECUTE FUNCTION public.assert_pdsv_axis_kinds();

COMMENT ON COLUMN product_dev_sku_variant.tamanho_id IS
  'Eixo tamanho (kind=tamanho). NULL = produto sem variação de tamanho → SKU segue base-cor.';
COMMENT ON COLUMN product_dev_sku_variant.weight_g IS
  'Peso fatiado DESTA combinação. NULL = herda do projeto. Existe porque tamanho muda o custo.';
COMMENT ON COLUMN product_dev_sku_variant.print_time_minutes IS
  'Tempo fatiado DESTA combinação. NULL = herda do projeto.';
