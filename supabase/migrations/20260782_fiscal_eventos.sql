-- Faturador F2b-7 — eventos da NF-e (cancelamento + carta de correção).
--
-- Cancelar tem prazo (24h na maioria das UFs) e a justificativa vai NO EVENTO
-- público — por isso fica registrada aqui também. Cancelamento NÃO reabre o
-- número da série: ele fica queimado, e é assim que a legislação espera.

ALTER TABLE public.fulfillment_invoices
  ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  -- nº de cartas de correção já enviadas (a próxima é cce_count + 1)
  ADD COLUMN IF NOT EXISTS cce_count     integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.fulfillment_invoices.cancelled_at IS
  'Quando a SEFAZ registrou o evento de cancelamento (110111).';
COMMENT ON COLUMN public.fulfillment_invoices.cancel_reason IS
  'Justificativa enviada à SEFAZ no cancelamento (mín. 15 caracteres, é pública).';
COMMENT ON COLUMN public.fulfillment_invoices.cce_count IS
  'Sequência da última carta de correção (110110) aceita.';
