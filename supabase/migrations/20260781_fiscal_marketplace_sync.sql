-- Faturador F2b-6 — devolver a NF-e pro marketplace.
--
-- A Shopee EXIGE a nota antes de liberar "Organizar Envio". Passamos a mandar
-- automaticamente após a autorização; estas colunas guardam o resultado pra
-- UI mostrar e pro reenvio saber o que falta.

ALTER TABLE public.fulfillment_invoices
  ADD COLUMN IF NOT EXISTS marketplace_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketplace_error   text,
  -- XML de DISTRIBUIÇÃO (nfeProc = NFe + protNFe). É o arquivo que o
  -- marketplace/contador aceita; o `xml_url` sozinho é só a nota assinada.
  ADD COLUMN IF NOT EXISTS proc_xml_url        text;

COMMENT ON COLUMN public.fulfillment_invoices.marketplace_sent_at IS
  'Quando a nota foi aceita pelo marketplace (Shopee upload_invoice_data). NULL = ainda não subiu.';
COMMENT ON COLUMN public.fulfillment_invoices.marketplace_error IS
  'Última falha ao subir a nota pro marketplace (para reenvio).';
COMMENT ON COLUMN public.fulfillment_invoices.proc_xml_url IS
  'Caminho do nfeProc (nota + protocolo) no storage — o arquivo de distribuição.';

CREATE INDEX IF NOT EXISTS idx_fulfillment_invoices_pendente_marketplace
  ON public.fulfillment_invoices(organization_id)
  WHERE status = 'issued' AND marketplace_sent_at IS NULL;
