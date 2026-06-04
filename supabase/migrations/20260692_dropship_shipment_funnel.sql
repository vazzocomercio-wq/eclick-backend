-- F2 · Funil de validação de expedição (dropship)
--
-- Muda a régua da OC: ela passa a fechar por DATA DE EXPEDIÇÃO confirmada
-- (shipped_at), não por data de venda. Itens não confirmados ficam em camada
-- anterior e entram na OC do dia em que forem confirmados (carry-forward
-- implícito pelo estado — só `eligible_for_oc`/`shipped_confirmed` entram).
--
-- Colunas:
--  - label_ready_at         : Camada 1 — etiqueta liberada (telemetria/prévia)
--  - partner_confirmed_at   : Camada 2b — parceiro confirmou o despacho
--  - partner_confirmed_by   : quem confirmou (auth.users)
--  - require_partner_shipment_confirmation : toggle por parceiro (default OFF)
--
-- shipped_at já existe na tabela e é reusado como a data de expedição.
-- Idempotente (IF NOT EXISTS).

ALTER TABLE dropship_order_identifications
  ADD COLUMN IF NOT EXISTS label_ready_at       timestamptz,
  ADD COLUMN IF NOT EXISTS partner_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS partner_confirmed_by uuid REFERENCES auth.users(id);

ALTER TABLE supplier_dropship_profiles
  ADD COLUMN IF NOT EXISTS require_partner_shipment_confirmation boolean NOT NULL DEFAULT false;

-- Coorte de OC: pedidos elegíveis por (org, fornecedor, data de expedição)
CREATE INDEX IF NOT EXISTS idx_dropship_ident_ship_cohort
  ON dropship_order_identifications (organization_id, supplier_id, shipped_at)
  WHERE dropship_status IN ('eligible_for_oc', 'shipped_confirmed') AND oc_id IS NULL;
