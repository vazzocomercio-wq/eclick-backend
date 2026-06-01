-- ═══════════════════════════════════════════════════════════════════
-- 20260687 — ML Ads: ACOS-alvo + estratégia (write Fase 3)
--
-- O Ads Performance Agent (Active) passa a APLICAR de verdade decisões de
-- Mercado Livre. A alavanca primária do Product Ads é o LANCE/ACOS-alvo
-- (muitas campanhas PADS têm daily_budget = null e operam por acos_target).
--
-- Capturamos no sync (GET .../product_ads/campaigns devolve `acos_target` e
-- `strategy`) e escrevemos no apply (PUT da campanha). Estas colunas são o
-- espelho local do estado atual — usadas pra montar before/after e rollback.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.ml_ads_campaigns
  ADD COLUMN IF NOT EXISTS acos_target numeric,
  ADD COLUMN IF NOT EXISTS strategy    text;

COMMENT ON COLUMN public.ml_ads_campaigns.acos_target IS
  'ACOS-alvo (%) da campanha PADS — alavanca de lance. ML exige > 3 e < 500. Escrito via updateCampaign (Fase 3).';
COMMENT ON COLUMN public.ml_ads_campaigns.strategy IS
  'Estratégia do PADS: PROFITABILITY (5-15%) | GROWTH (15-30%) | VISIBILITY (>30%).';
