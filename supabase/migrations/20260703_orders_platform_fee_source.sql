-- Auditoria de taxas Shopee 2026-07-03: rastreia a ORIGEM do platform_fee do
-- pedido. 'estimated' = calculado pelas regras de tarifa (channel_fee_rules)
-- na ingestão; 'escrow' = valor REAL reconciliado do repasse da plataforma
-- (platform_charges, source shopee_escrow). Linha 'escrow' nunca regride pra
-- estimativa no re-sync (guard na ingestão).
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS platform_fee_source text NOT NULL DEFAULT 'estimated';

COMMENT ON COLUMN public.orders.platform_fee_source IS
  'Origem do platform_fee: estimated (regras de tarifa) | escrow (repasse real da plataforma)';
