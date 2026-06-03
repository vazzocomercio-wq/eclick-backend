-- Operação de Cadastro → fluxo Pendente / Despachado / Anunciado / Incompleto.
-- O despacho passa a guardar os CANAIS que o operador deve anunciar; o produto
-- vira "Anunciado" quando TODOS os canais selecionados estiverem publicados
-- (detectado via creative_publications). Incompleto = anunciado mas catálogo
-- com campos faltando.
--
-- Já APLICADA em prod via _admin_exec_sql (idempotente). Este arquivo é o registro.

ALTER TABLE product_operator_assignments
  ADD COLUMN IF NOT EXISTS target_channels text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE product_operator_assignments
  ADD COLUMN IF NOT EXISTS announced_at timestamptz;
