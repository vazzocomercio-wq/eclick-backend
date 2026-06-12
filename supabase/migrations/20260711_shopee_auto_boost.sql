-- F18 Auto-Boost Inteligente — boost GRATUITO da Shopee (5 slots simultâneos
-- por loja, cada boost dura 4h) escolhido pelo e-Click 24/7.
--
-- boost_config: opt-in POR LOJA (toggle na tela) + estratégia + exclusões.
-- boost_log:    histórico de cada boost aplicado (racional completo) — alimenta
--               a rotação (não repetir item antes de N horas) e a tela.
--
-- Schema shopee (já exposto ao PostgREST). GRANTs explícitos: tabela criada via
-- _admin_exec_sql NÃO herda default privileges (bug J — permission denied).

GRANT USAGE ON SCHEMA shopee TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS shopee.boost_config (
  organization_id   uuid   NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id           bigint NOT NULL,
  enabled           boolean NOT NULL DEFAULT false,
  -- balanced | margin | visibility | giro (pesos do ranking composto)
  strategy          text    NOT NULL DEFAULT 'balanced',
  -- itens que o user tirou da vitrine automática (array de item_id)
  excluded_item_ids jsonb   NOT NULL DEFAULT '[]'::jsonb,
  -- teto por ciclo (a Shopee libera até 5 slots; user pode querer menos)
  max_per_cycle     int     NOT NULL DEFAULT 5,
  -- não repetir o mesmo item antes de N horas (rotação da vitrine)
  rotation_hours    int     NOT NULL DEFAULT 48,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, shop_id)
);

CREATE TABLE IF NOT EXISTS shopee.boost_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid   NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_id         bigint NOT NULL,
  item_id         bigint NOT NULL,
  product_id      uuid,
  title           text,
  boosted_at      timestamptz NOT NULL DEFAULT now(),
  -- componentes do ranking no momento do boost (auditoria do racional)
  algo_score      int,
  margin_pct      numeric,
  stock           int,
  sales_30d       int,
  composite       numeric,
  motivo          text,
  -- auto (cron) | manual (botão da tela)
  source          text NOT NULL DEFAULT 'auto'
);

CREATE INDEX IF NOT EXISTS idx_boost_log_org_shop
  ON shopee.boost_log (organization_id, shop_id, boosted_at DESC);
CREATE INDEX IF NOT EXISTS idx_boost_log_org_item
  ON shopee.boost_log (organization_id, item_id, boosted_at DESC);

ALTER TABLE shopee.boost_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopee.boost_log    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members boost config read" ON shopee.boost_config;
CREATE POLICY "org members boost config read"
  ON shopee.boost_config FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "org members boost log read" ON shopee.boost_log;
CREATE POLICY "org members boost log read"
  ON shopee.boost_log FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

GRANT ALL    ON TABLE shopee.boost_config TO service_role;
GRANT SELECT ON TABLE shopee.boost_config TO authenticated;
GRANT ALL    ON TABLE shopee.boost_log    TO service_role;
GRANT SELECT ON TABLE shopee.boost_log    TO authenticated;
