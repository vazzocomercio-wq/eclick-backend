-- 20260716_rename_channel_take_rate.sql
-- Renomeia (de forma segura, zero-downtime) org_channel_settings.commission_pct
-- → estimated_take_rate_pct.
--
-- Motivo: o valor NÃO é só comissão — é o TAKE RATE estimado da plataforma
-- (comissão + taxa de serviço + transação + programas/frete-grátis). Chamar de
-- "comissão" confundia o time (ex.: Shopee BR ~33%, não os ~13% de comissão pura).
--
-- Estratégia zero-downtime: ADD + backfill nesta migration (as duas colunas
-- coexistem; o backend novo escreve em AMBAS durante 1 ciclo de deploy). A
-- coluna antiga `commission_pct` é removida numa migration de limpeza na Fase 2,
-- depois que backend e frontend novos estiverem no ar. Idempotente.

ALTER TABLE public.org_channel_settings
  ADD COLUMN IF NOT EXISTS estimated_take_rate_pct numeric NOT NULL DEFAULT 0;

-- backfill a partir da coluna antiga (só onde ainda divergem)
UPDATE public.org_channel_settings
  SET estimated_take_rate_pct = commission_pct
  WHERE estimated_take_rate_pct IS DISTINCT FROM commission_pct;

COMMENT ON COLUMN public.org_channel_settings.estimated_take_rate_pct IS
  'Take rate ESTIMADO da plataforma em % (0-100): comissão + serviço + transação + programas/frete-grátis. Estima o platform_fee PRÉ-venda; a verdade PÓS-venda vem do escrow/fatura real (platform_charges).';

COMMENT ON COLUMN public.org_channel_settings.commission_pct IS
  'DEPRECATED — substituída por estimated_take_rate_pct. Mantida 1 ciclo de deploy p/ back-compat; será removida na Fase 2.';
