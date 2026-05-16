-- 20260570_org_default_tax.sql
--
-- Imposto padrão da organização (cadastro central). O cálculo de margem
-- resolve o imposto de um produto assim:
--   produto.tax_percentage  →  se NULL, herda organizations.default_tax_percentage
--   produto.tax_on_freight  →  se NULL, herda organizations.default_tax_on_freight
--
-- Permite cadastrar uma vez e valer pra todo o catálogo, mantendo override
-- por produto quando necessário. A aplicação em massa (preencher todos os
-- produtos ou só os sem imposto) é feita pelo endpoint PUT /products/tax-config.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS default_tax_percentage numeric,
  ADD COLUMN IF NOT EXISTS default_tax_on_freight boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.default_tax_percentage IS
  'Imposto padrão (%) da org. Herdado por produtos com tax_percentage NULL.';
COMMENT ON COLUMN organizations.default_tax_on_freight IS
  'Default de tax_on_freight pra produtos sem o campo definido.';
