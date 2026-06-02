-- ═══════════════════════════════════════════════════════════════════
-- 20260690 — Tarifas de frete por marketplace/tipo logístico (com vigência)
--
-- Custo de frete que o VENDEDOR paga POR FORA e que NÃO aparece em nenhuma
-- API do ML/MP. Caso âncora: Mercado Envios FLEX (self_service) — a Vazzo paga
-- um valor FIXO por venda à transportadora/motoboy (ex R$12,99), e o ML devolve
-- um "Bônus por envio" variável (crédito, capturado à parte na Fase 2).
--
-- Versionado por vigência (valid_from/valid_to) como operating_costs: quando há
-- REAJUSTE de tabela, cadastra-se uma linha nova com nova data — os pedidos
-- passados continuam usando a tarifa válida NA DATA DA VENDA (DRE histórica correta).
--
-- ⚠️ Tabela criada via _admin_exec_sql NÃO herda default privileges → GRANT
-- explícito. Acesso sempre via API (SupabaseAuthGuard → supabaseAdmin,
-- service_role, filtra org_id na query) — service_role only, igual operating_costs.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.marketplace_shipping_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  -- plataforma do marketplace (extensível: shopee, tiktok_shop…)
  platform         varchar(24)  NOT NULL DEFAULT 'mercadolivre',
  -- tipo logístico (caso âncora: self_service = Flex). Extensível.
  logistic_type    varchar(32)  NOT NULL DEFAULT 'self_service',
  -- valor em R$ pago POR VENDA (custo bruto, antes do bônus do ML)
  amount           numeric(14,2) NOT NULL CHECK (amount >= 0),
  -- vigência: a tarifa vale de valid_from até valid_to (null = vigente)
  valid_from       date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  valid_to         date,
  active           boolean NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Lookup por org+plataforma+tipo+vigência (consumido pelo motor de DRE — Fase 2)
CREATE INDEX IF NOT EXISTS idx_mkt_shipping_rates_lookup
  ON public.marketplace_shipping_rates (organization_id, platform, logistic_type, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_shipping_rates TO service_role;
