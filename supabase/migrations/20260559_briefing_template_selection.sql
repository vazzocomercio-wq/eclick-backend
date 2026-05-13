-- F6: vincula briefing a um "tipo de produto" (template de imagens) + slots escolhidos.
--
-- Antes:  briefing era independente de template. O pipeline matchava template
--         automaticamente via matchTemplateForProduct (category_ml_ids > default > recent)
--         e usava as N primeiras positions, onde N = briefing.image_count.
--
-- Depois: briefing pode persistir explicitamente:
--   • template_id        — qual "tipo de produto" usar (Pendente, Plafon, Arandela…)
--                          Quando NULL, fallback pro matching automático antigo.
--   • selected_positions — quais slots gerar (ex: [3, 5, 7] = só esses 3 ambientes).
--                          Quando vazio, fallback pra "N primeiras" antigo.
--
-- Backward compat: briefings antigos sem template_id continuam funcionando via match
-- automático. Novos briefings via UI v2 preenchem os campos.

ALTER TABLE creative_briefings
  ADD COLUMN IF NOT EXISTS template_id uuid
    REFERENCES creative_image_prompt_templates(id) ON DELETE SET NULL;

ALTER TABLE creative_briefings
  ADD COLUMN IF NOT EXISTS selected_positions int[] NOT NULL DEFAULT '{}';

-- Index pra buscar briefings por template (analytics: quais tipos são mais usados)
CREATE INDEX IF NOT EXISTS idx_creative_briefings_template
  ON creative_briefings(template_id)
  WHERE template_id IS NOT NULL;

COMMENT ON COLUMN creative_briefings.template_id IS
  'F6: Tipo de produto escolhido (FK pra creative_image_prompt_templates). NULL = auto-match pela categoria ML.';

COMMENT ON COLUMN creative_briefings.selected_positions IS
  'F6: Slots do template que serão gerados (1 imagem por slot). Vazio = usa "N primeiras" conforme image_count antigo.';
