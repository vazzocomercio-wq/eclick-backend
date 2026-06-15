-- 20260720_reconciliation_by_category.sql
-- Adiciona a quebra por CATEGORIA do produto à reconciliação (take real por
-- categoria, rateando a taxa do pedido entre as linhas). Dá o dado p/ calibrar
-- regras por categoria sem fabricar número. Aditiva. Idempotente.

ALTER TABLE public.channel_take_reconciliation
  ADD COLUMN IF NOT EXISTS by_category jsonb NOT NULL DEFAULT '[]'::jsonb;
