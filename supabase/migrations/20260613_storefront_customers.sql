-- Loja Própria — accounts de cliente.
--
-- Cliente da loja NÃO é user do SaaS (auth.users) — é entidade própria.
-- Usa email + senha hasheada (bcrypt). JWT próprio com claims simples:
-- { sub: customer.id, org_id, email }.
--
-- Importante:
--  - Email é único por organization_id (mesmo email pode comprar em
--    lojas diferentes, contas separadas)
--  - addresses[] permite múltiplos endereços salvos (entrega/cobrança)
--  - storefront_orders.customer_id FK opcional — pedidos antigos sem
--    customer_id ficam ligados via customer.email

CREATE TABLE IF NOT EXISTS public.storefront_customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  email               text NOT NULL,
  password_hash       text NOT NULL,                    -- bcrypt
  name                text NOT NULL,
  phone               text,
  doc                 text,                              -- CPF/CNPJ

  addresses           jsonb NOT NULL DEFAULT '[]'::jsonb,
                       -- [{ id, label, zip, street, number, complement, neighborhood, city, state, is_default }]

  -- Marketing
  accepts_marketing   boolean NOT NULL DEFAULT false,

  -- Audit
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_storefront_customers_org_email
  ON public.storefront_customers (organization_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_storefront_customers_org_created
  ON public.storefront_customers (organization_id, created_at DESC);

COMMENT ON TABLE public.storefront_customers IS
  'Clientes da Loja Própria (signup/login próprio, NÃO auth.users do SaaS).';

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.tg_storefront_customers_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_storefront_customers_touch ON public.storefront_customers;
CREATE TRIGGER trg_storefront_customers_touch
  BEFORE UPDATE ON public.storefront_customers
  FOR EACH ROW EXECUTE FUNCTION public.tg_storefront_customers_touch();

-- FK opcional em storefront_orders pra ligar pedidos a customer existente
ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.storefront_customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_storefront_orders_customer
  ON public.storefront_orders (customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

GRANT ALL ON TABLE public.storefront_customers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_customers TO authenticated;
