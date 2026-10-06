-- Product OS / Farm — posição física da impressora na print farm.
-- Endereço da POSIÇÃO (não da máquina): "R01-N2-A-03" = estante R01, nível 2,
-- corredor/lado A, posição 03 (numeração cresce da porta pro fundo).
-- Fonte do endereçamento: vazzo-produtos-3d/fabrica/layout/enderecos.py (48 posições).
ALTER TABLE public.production_printer
  ADD COLUMN IF NOT EXISTS farm_slot text;

-- uma máquina por posição dentro da org (posição vazia = NULL, pode repetir)
CREATE UNIQUE INDEX IF NOT EXISTS production_printer_org_farm_slot_uq
  ON public.production_printer (organization_id, farm_slot)
  WHERE farm_slot IS NOT NULL;

COMMENT ON COLUMN public.production_printer.farm_slot IS
  'Endereço físico na print farm: R{estante}-N{nível}-{lado A|B}-{posição 01..04}. NULL = sem posição.';
