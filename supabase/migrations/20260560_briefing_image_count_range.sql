-- F6 fix: relaxa o CHECK de image_count.
--
-- Antes:  image_count IN (5, 7, 10, 11) — valores fixos do MVP do briefing.
-- Depois: image_count BETWEEN 1 AND 20 — necessário pra suportar
--         selected_positions de tamanhos variáveis (ex: user marca 3 ou 14 slots).
--
-- Sem isso, criar briefing com selected_positions.length fora de (5,7,10,11)
-- falha com check_constraint violation.

ALTER TABLE creative_briefings
  DROP CONSTRAINT IF EXISTS creative_briefings_image_count_check;

ALTER TABLE creative_briefings
  ADD CONSTRAINT creative_briefings_image_count_check
  CHECK (image_count BETWEEN 1 AND 20);

COMMENT ON COLUMN creative_briefings.image_count IS
  'F6: quantidade de imagens a gerar (1..20). Quando selected_positions tem itens, é igual a selected_positions.length (1 imagem por slot).';
