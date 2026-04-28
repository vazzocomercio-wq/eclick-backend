-- Customer Intelligence Hub Parte 4/4 — Messaging Studio
-- 4 tabelas: templates, journeys, runs (estado), sends (histórico).
-- RLS service_role-only. Seed de 4 templates default na org Vazzo.

CREATE TABLE IF NOT EXISTS messaging_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  name            TEXT NOT NULL,
  channel         TEXT DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp','instagram','tiktok')),
  trigger_event   TEXT NOT NULL CHECK (trigger_event IN (
    'order_paid','order_shipped','order_delivered',
    'order_cancelled','post_sale_7d','post_sale_30d',
    'manual','lead_bridge_capture'
  )),
  message_body    TEXT NOT NULL,
  variables       JSONB DEFAULT '[]',
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messaging_journeys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_event   TEXT NOT NULL,
  trigger_channel TEXT DEFAULT 'whatsapp',
  is_active       BOOLEAN DEFAULT true,
  mode            TEXT DEFAULT 'automatic'
    CHECK (mode IN ('automatic','manual','campaign')),
  steps           JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messaging_journey_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  journey_id      UUID REFERENCES messaging_journeys(id),
  order_id        TEXT,
  customer_id     UUID,
  phone           TEXT,
  current_step    INT DEFAULT 0,
  status          TEXT DEFAULT 'active'
    CHECK (status IN ('active','completed','failed','paused')),
  next_step_at    TIMESTAMPTZ,
  context         JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messaging_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  journey_run_id  UUID REFERENCES messaging_journey_runs(id),
  template_id     UUID REFERENCES messaging_templates(id),
  channel         TEXT NOT NULL,
  phone           TEXT NOT NULL,
  customer_id     UUID,
  order_id        TEXT,
  message_body    TEXT NOT NULL,
  status          TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','sent','delivered','failed','read')),
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  error           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_templates_org
  ON messaging_templates(organization_id, trigger_event);
CREATE INDEX IF NOT EXISTS idx_msg_journeys_org
  ON messaging_journeys(organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_msg_runs_next_step
  ON messaging_journey_runs(next_step_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_msg_sends_org
  ON messaging_sends(organization_id, created_at DESC);

ALTER TABLE messaging_templates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_journeys      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_journey_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_sends         ENABLE ROW LEVEL SECURITY;

GRANT ALL ON messaging_templates    TO service_role;
GRANT ALL ON messaging_journeys     TO service_role;
GRANT ALL ON messaging_journey_runs TO service_role;
GRANT ALL ON messaging_sends        TO service_role;

DROP POLICY IF EXISTS srv_msg_templates ON messaging_templates;
DROP POLICY IF EXISTS srv_msg_journeys  ON messaging_journeys;
DROP POLICY IF EXISTS srv_msg_runs      ON messaging_journey_runs;
DROP POLICY IF EXISTS srv_msg_sends     ON messaging_sends;
CREATE POLICY srv_msg_templates ON messaging_templates
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_msg_journeys ON messaging_journeys
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_msg_runs ON messaging_journey_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY srv_msg_sends ON messaging_sends
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO messaging_templates
  (organization_id, name, channel, trigger_event, message_body, variables)
VALUES
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833',
   'Confirmação de pedido', 'whatsapp', 'order_paid',
   'Olá {{nome}}! 🎉 Seu pedido #{{pedido}} foi confirmado e já está sendo preparado. Em breve você receberá as informações de rastreio. Obrigado por comprar na {{loja}}!',
   '["nome","pedido","loja"]'),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833',
   'Pedido enviado', 'whatsapp', 'order_shipped',
   'Boa notícia, {{nome}}! 📦 Seu pedido #{{pedido}} foi enviado! Rastreie aqui: {{rastreio}}. Previsão de entrega em breve.',
   '["nome","pedido","rastreio"]'),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833',
   'Pedido entregue', 'whatsapp', 'order_delivered',
   'Oi {{nome}}! Seu pedido #{{pedido}} foi entregue! 🎊 Esperamos que você adoree. Que tal deixar uma avaliação? Sua opinião é muito importante para nós!',
   '["nome","pedido"]'),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833',
   'Pós-venda 7 dias', 'whatsapp', 'post_sale_7d',
   'Olá {{nome}}! Tudo certo com seu {{produto}}? 😊 Se precisar de qualquer ajuda, estamos aqui. Aproveite: use o cupom {{cupom}} para 10% de desconto na próxima compra!',
   '["nome","produto","cupom"]')
ON CONFLICT DO NOTHING;
