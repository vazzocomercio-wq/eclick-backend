-- Cashback FIFO — lotes com saldo remanescente por earn.
--
-- Bug corrigido: a expiração (cron) descontava o valor CHEIO do earn mesmo
-- quando ele já tinha sido (parcial ou totalmente) resgatado — punição dupla
-- que tirava do cliente cashback que era dele.
--
-- Modelo novo: cada movimento type='earn' é um LOTE com `remaining_cents`
-- (saldo ainda não gasto desse lote). Resgate consome lotes FIFO (vence
-- antes → sai antes). Expiração tira só o `remaining_cents` do lote.
--
-- Invariante: balance_cents == Σ remaining_cents dos lotes ATIVOS (não
-- expirados). O backfill (scripts/cashback-backfill-lots.mjs) preenche os
-- earns já existentes; até lá, remaining_cents fica NULL (legado) e o caminho
-- antigo é usado como fallback (sem regressão).

ALTER TABLE public.customer_cashback_movements
  ADD COLUMN IF NOT EXISTS remaining_cents integer;

-- Índice pro consumo FIFO + varredura de expiração (só lotes vivos).
CREATE INDEX IF NOT EXISTS idx_cashback_lots_fifo
  ON public.customer_cashback_movements (organization_id, customer_identifier, expires_at, created_at)
  WHERE type = 'earn' AND remaining_cents > 0;

COMMENT ON COLUMN public.customer_cashback_movements.remaining_cents IS
  'Saldo remanescente do lote (só type=earn). NULL = legado não-backfillado. Resgate consome FIFO; expiração tira apenas este valor.';
