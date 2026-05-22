-- Ambientador IA — hardening (AH polish).
--
--  - consent_at: timestamp do aceite LGPD do cliente (foto do ambiente + dados
--    pessoais). Gravado no cadastro quando o cliente marca o consentimento.
--  - client_ip_hash nos OTPs: permite rate-limit por IP (anti-abuso de envio
--    de WhatsApp), além do limite por telefone que já existe.

ALTER TABLE public.storefront_visualizer_customers
  ADD COLUMN IF NOT EXISTS consent_at timestamptz;

ALTER TABLE public.storefront_visualizer_otps
  ADD COLUMN IF NOT EXISTS client_ip_hash text;

CREATE INDEX IF NOT EXISTS idx_sf_visualizer_otps_ip
  ON public.storefront_visualizer_otps (organization_id, client_ip_hash, created_at DESC);
