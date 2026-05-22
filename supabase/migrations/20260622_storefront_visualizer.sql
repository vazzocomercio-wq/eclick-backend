-- Loja Própria — Ambientador IA / "Veja no seu espaço" (AH).
--
-- O cliente da vitrine tira/sobe uma foto do ambiente dele e a IA aplica o
-- produto na cena (fiel; só corrige exposição/ruído/inclinação). A função
-- só é liberada após Nome + e-mail + WhatsApp validado por OTP. Cada cliente
-- tem N gerações (default 3), cada geração produz 2 imagens. Compra aprovada
-- renova os créditos automaticamente; o lojista também pode conceder extras.
--
-- 3 tabelas:
--   storefront_visualizer_customers   — "contato da loja" (passwordless), créditos, link Active
--   storefront_visualizer_otps        — códigos OTP de validação WhatsApp (hash + TTL)
--   storefront_visualizer_generations — log/galeria das ambientações geradas

-- ── 1. Clientes (contato leve da loja) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.storefront_visualizer_customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  store_slug          text NOT NULL,

  name                text,
  email               text,
  phone               text NOT NULL,            -- só dígitos (E.164 sem +)

  whatsapp_validated  boolean NOT NULL DEFAULT false,
  validated_at        timestamptz,

  -- Vínculo com o contato no Active CRM (ref lógica cross-project, sem FK)
  active_contact_id   text,

  -- Créditos de geração. remaining = generations_allowed - generations_used.
  generations_allowed integer NOT NULL DEFAULT 3,
  generations_used    integer NOT NULL DEFAULT 0,
  last_renewed_at     timestamptz,

  client_ip_hash      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_sf_visualizer_customers_org
  ON public.storefront_visualizer_customers (organization_id, created_at DESC);

COMMENT ON TABLE public.storefront_visualizer_customers IS
  'Clientes da vitrine que desbloquearam o Ambientador IA (Nome+email+WhatsApp validado). Créditos de geração + link com contato no Active.';

-- ── 2. OTPs de validação de WhatsApp ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.storefront_visualizer_otps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone               text NOT NULL,            -- só dígitos
  code_hash           text NOT NULL,            -- SHA-256 do código de 6 dígitos
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  attempts            integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sf_visualizer_otps_lookup
  ON public.storefront_visualizer_otps (organization_id, phone, created_at DESC);

COMMENT ON TABLE public.storefront_visualizer_otps IS
  'Códigos OTP (hash + TTL) enviados por WhatsApp pra validar a posse do número antes de liberar o Ambientador IA.';

-- ── 3. Gerações (log + galeria) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.storefront_visualizer_generations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES public.storefront_visualizer_customers(id) ON DELETE CASCADE,
  store_slug          text NOT NULL,

  product_id          uuid,                     -- public.products.id (ref lógica)
  product_name        text,

  scene_image_url     text NOT NULL,            -- foto do ambiente do cliente (bucket público)
  output_urls         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- imagens geradas

  status              text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error               text,
  cost_usd            numeric,

  active_deal_id      text,                     -- card criado no funil de atendimento
  whatsapp_sent       boolean NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sf_visualizer_gen_org
  ON public.storefront_visualizer_generations (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sf_visualizer_gen_customer
  ON public.storefront_visualizer_generations (customer_id, created_at DESC);

COMMENT ON TABLE public.storefront_visualizer_generations IS
  'Cada ambientação gerada pelo cliente: foto da cena + imagens resultantes + entrega WhatsApp + card no Active.';

-- ── 4. Trigger updated_at nos customers ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_sf_visualizer_customers_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sf_visualizer_customers_touch ON public.storefront_visualizer_customers;
CREATE TRIGGER trg_sf_visualizer_customers_touch
  BEFORE UPDATE ON public.storefront_visualizer_customers
  FOR EACH ROW EXECUTE FUNCTION public.tg_sf_visualizer_customers_touch();

-- ── 5. Config do Ambientador na store_config (jsonb passthrough) ─────────────
--   { enabled, pipeline_id, stage_id, assigned_to, coupon_code,
--     default_generations, prompt_extra, button_label }
ALTER TABLE public.store_config
  ADD COLUMN IF NOT EXISTS visualizer_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── 6. Grants (criação via _admin_exec_sql não herda privilégios) ───────────
GRANT ALL ON TABLE public.storefront_visualizer_customers   TO service_role;
GRANT ALL ON TABLE public.storefront_visualizer_otps        TO service_role;
GRANT ALL ON TABLE public.storefront_visualizer_generations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_visualizer_customers   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_visualizer_otps        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_visualizer_generations TO authenticated;
