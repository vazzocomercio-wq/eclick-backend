-- ═══════════════════════════════════════════════════════════════════
-- 20260691 — platform_charges: ledger REAL de custos por plataforma
--
-- Fase 2 da Central de Resultado. A FONTE DA VERDADE de quanto cada marketplace
-- consome — vinda do ledger oficial, NÃO do nível de pedido (que mente):
--   • ML  → API de faturamento /billing/integration/.../details (comissão, frete,
--           parcelamento, cobrança MP, Ads, devoluções, cancelamentos…)
--   • Shopee → escrow get_escrow_detail (comissão + taxa de serviço + transação)
--   • TikTok → settlement (futuro)
--
-- Cada linha = UMA cobrança ou crédito real. `detail_type` = 'charge'|'credit';
-- o net de uma categoria = Σ(charge) − Σ(credit). `charge_date` é a data usada
-- pro fechamento por MÊS CALENDÁRIO (1–31) — sale_date_time no ML, sold_at na
-- Shopee — independente do período da fatura (30→29 no ML).
--
-- ⚠️ Tabela via _admin_exec_sql NÃO herda default privileges → GRANT explícito,
-- service_role only (acesso via API → supabaseAdmin filtra org_id).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.platform_charges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  platform          varchar(24) NOT NULL,        -- mercadolivre | shopee | tiktok_shop
  -- categoria de negócio (normalizada): comissao | frete | parcelamento |
  -- cobranca | ads | servico | imposto | flex_freight | outros
  charge_category   varchar(24) NOT NULL,
  raw_subtype       varchar(48),                 -- CVVML/PADS/CXDE/commission_fee/service_fee…
  detail_type       varchar(8)  NOT NULL DEFAULT 'charge'
                      CHECK (detail_type IN ('charge','credit')),
  amount            numeric(14,2) NOT NULL,      -- sempre >= 0; o sinal vem de detail_type
  external_order_id text,                        -- pedido relacionado (pode ser null)
  charge_date       date NOT NULL,               -- data p/ bucketing por mês calendário
  period_key        varchar(16),                 -- referência da fonte (ex fatura ML '2026-05-01')
  source            varchar(24) NOT NULL,        -- ml_billing | shopee_escrow | tiktok_settlement
  source_detail_id  varchar(64) NOT NULL,        -- detail_id ML / order_sn:campo Shopee — idempotência
  currency          varchar(8)  NOT NULL DEFAULT 'BRL',
  raw               jsonb,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Idempotência: re-ingestão da mesma linha não duplica (upsert por este par).
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_charges_source
  ON public.platform_charges (organization_id, source, source_detail_id);

-- Lookup do motor de DRE: por org + plataforma + mês (charge_date).
CREATE INDEX IF NOT EXISTS idx_platform_charges_dre
  ON public.platform_charges (organization_id, platform, charge_date);

-- Lookup por pedido (atribuição por SKU na DRE por produto).
CREATE INDEX IF NOT EXISTS idx_platform_charges_order
  ON public.platform_charges (organization_id, external_order_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_charges TO service_role;
