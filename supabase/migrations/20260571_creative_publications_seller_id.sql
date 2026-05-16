-- Multi-conta na publicação ML: registra em qual conta ML o anúncio subiu.
-- Sem isso, publicar com várias contas conectadas cria registros sem como
-- distinguir a conta de destino.
ALTER TABLE public.creative_publications
  ADD COLUMN IF NOT EXISTS seller_id bigint;

COMMENT ON COLUMN public.creative_publications.seller_id
  IS 'seller_id da conta ML (ml_connections) onde o anúncio foi publicado.';
