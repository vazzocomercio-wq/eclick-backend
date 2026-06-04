-- F3 · Camada de frete (fundação)
--
-- Entidade de transportadora normalizada: o ciclo de vida de rastreio
-- (label_ready -> posted -> in_transit -> delivered) que vai alimentar o
-- funil dropship (Camadas 1/2) independente do provider (Melhor Envio,
-- Frenet, Correios, manual). Distinta de `shipment_labels` (artefato do WMS):
-- esta é a fonte de verdade de RASTREIO; pode referenciar a label/fulfillment.
--
-- Aditiva e inerte: nada lê isto ainda (providers concretos chegam na F4+).
-- Idempotente.

CREATE TABLE IF NOT EXISTS shipments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- vínculos opcionais (um shipment pode amarrar a pedido/identificação/fulfillment)
  identification_id    uuid REFERENCES dropship_order_identifications(id) ON DELETE SET NULL,
  order_id             uuid,
  fulfillment_order_id uuid,

  -- transportadora / provider
  provider             text NOT NULL DEFAULT 'manual'
    CHECK (provider IN ('manual', 'melhor_envio', 'frenet', 'correios')),
  carrier              text,
  service              text,

  -- rastreio
  external_id          text,   -- id da etiqueta/envio no provider (ex: ME order id)
  tracking_code        text,
  tracking_url         text,

  -- ciclo de vida normalizado (ShipmentEvent.status)
  status               text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'label_ready', 'posted', 'in_transit', 'delivered', 'undelivered', 'cancelled')),
  label_ready_at       timestamptz,
  posted_at            timestamptz,
  delivered_at         timestamptz,

  -- custo do frete (entra no custo quando aplicável)
  freight_cost         numeric(12,2),

  -- payload bruto do provider (auditoria)
  raw                  jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipments_org      ON shipments (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipments_ident    ON shipments (identification_id) WHERE identification_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments (tracking_code) WHERE tracking_code IS NOT NULL;
-- Unique (provider, external_id) p/ upsert idempotente; NULLs são distintos no PG,
-- então múltiplos shipments manuais sem external_id coexistem normalmente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_provider_ext ON shipments (provider, external_id);

ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shipments_org_policy ON shipments;
CREATE POLICY shipments_org_policy ON shipments
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

GRANT ALL ON shipments TO service_role;
