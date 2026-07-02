-- Composição do prato: uma versão (arquivo fatiado) pode render VÁRIAS peças
-- por prato — cópias da mesma peça e/ou peças diferentes impressas juntas.
-- [{ "part_id": uuid, "units": int }] — quando presente, os números da versão
-- (peso/tempo) valem POR PRATO e a quantidade da OP conta PRATOS.
alter table public.product_dev_version add column if not exists plate_composition jsonb;
