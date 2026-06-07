-- Modal de envio (logistic_type do ML) no funil dropship, pra:
--  - exibir o modal por item na OC (Flex/Coletas/Agência/Correios/Full)
--  - excluir Full (fulfillment) do fluxo de OC por venda (acerto separado):
--    o parceiro foi pago no abastecimento do CD, não por venda.
--
-- Valores ML: self_service (Flex), cross_docking (Coletas), drop_off /
-- xd_drop_off (Agência/Correios), fulfillment (Full). Guardamos o valor cru;
-- o rótulo amigável é resolvido no front. Aditiva, nullable, idempotente.

ALTER TABLE dropship_order_identifications
  ADD COLUMN IF NOT EXISTS logistic_type text;

ALTER TABLE dropship_purchase_order_items
  ADD COLUMN IF NOT EXISTS logistic_type text;
