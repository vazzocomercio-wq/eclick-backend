-- ============================================================
-- Product OS — fix: 'pronta' faltava na constraint CHECK de production_order.status
--
-- OP de PEÇA conclui em 'pronta' (vira estoque de peça), mas a constraint não
-- listava esse valor → o UPDATE status='pronta' era rejeitado pelo banco. Como
-- o transitionOrder não checava o erro, o status ficava preso em 'qualidade'
-- (embora o crédito de estoque rodasse). Aditivo: só acrescenta 'pronta'.
-- ============================================================
ALTER TABLE production_order DROP CONSTRAINT IF EXISTS production_order_status_check;
ALTER TABLE production_order ADD CONSTRAINT production_order_status_check
  CHECK (status = ANY (ARRAY[
    'fila'::text, 'imprimindo'::text, 'pausado'::text, 'falhou'::text,
    'reimpressao'::text, 'acabamento'::text, 'qualidade'::text, 'pronta'::text,
    'embalado'::text, 'disponivel'::text, 'cancelado'::text
  ]));
