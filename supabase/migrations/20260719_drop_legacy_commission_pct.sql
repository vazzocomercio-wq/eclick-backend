-- 20260719_drop_legacy_commission_pct.sql
-- Limpeza da Fase 2: remove a coluna legada org_channel_settings.commission_pct,
-- já substituída por estimated_take_rate_pct (mig 20260716).
--
-- ⚠️ APLICAR SOMENTE depois que o backend sem dual-write estiver 100% no ar
-- (a versão que ainda escrevia commission_pct precisa ter saído de rotação),
-- senão um upsert da instância antiga falha. O frontend novo já lê o nome novo
-- (com fallback), e o ChannelSettingsService devolve o alias commission_pct
-- COMPUTADO na resposta — nenhum consumidor lê a coluna do banco. Idempotente.

ALTER TABLE public.org_channel_settings
  DROP COLUMN IF EXISTS commission_pct;
