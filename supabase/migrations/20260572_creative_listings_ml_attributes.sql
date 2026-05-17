-- Fonte única dos atributos ML do anúncio. Antes os atributos eram editados
-- em dois lugares com modelos diferentes: a ficha técnica do editor
-- (technical_sheet, chave→valor por nome) e o formulário da tela de
-- publicação (estado efêmero, id→value_id). Esta coluna unifica: id do
-- atributo ML + value_id/value_name, com value_id "-1" = "não se aplica".
ALTER TABLE public.creative_listings
  ADD COLUMN IF NOT EXISTS ml_attributes jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.creative_listings.ml_attributes
  IS 'Atributos ML do anúncio: [{id, value_id?, value_name?}]. value_id "-1" = não se aplica. Fonte única, editada no editor e na publicação.';
