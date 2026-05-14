-- Sessão 2026-05-14 — Integração com ERPs de fornecedores de dropship.
-- Primeira integração: Icarus (Pennacorp). Multi-tenant por design:
-- 1 linha por (supplier_id, integration_type), permite N integrações por org.
--
-- access_token é encriptado AES-256-GCM via crypto.util.ts (mesma key MARKETPLACE_CONFIG_KEY).
-- request_token (JWT curto do Icarus) é cacheado em memória pelo service, não persistido.

CREATE TABLE IF NOT EXISTS public.supplier_integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_id       uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  -- Tipo da integração ('icarus' por enquanto; pode ter 'bling', 'tiny', etc. futuro)
  integration_type  text NOT NULL CHECK (integration_type IN ('icarus')),
  -- access_token encriptado (JSON com iv+tag+ct). NUNCA armazenar plain.
  access_token_encrypted text NOT NULL,
  -- Config livre por integração (ex: { base_url, rate_limit_rpm, ecomm_only, ... })
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Telemetria de sync
  last_synced_at    timestamptz,
  last_sync_status  text CHECK (last_sync_status IN ('success', 'failed', 'partial')),
  last_sync_error   text,
  total_synced      integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 1 integração ativa por (supplier, type) — evita ambiguidade
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_integ_unique_active
  ON public.supplier_integrations (supplier_id, integration_type)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_supplier_integ_org
  ON public.supplier_integrations (organization_id, integration_type, is_active);

CREATE INDEX IF NOT EXISTS idx_supplier_integ_sync_due
  ON public.supplier_integrations (last_synced_at NULLS FIRST)
  WHERE is_active = true;

ALTER TABLE public.supplier_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS si_select ON public.supplier_integrations;
CREATE POLICY si_select ON public.supplier_integrations
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS si_service ON public.supplier_integrations;
CREATE POLICY si_service ON public.supplier_integrations
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON public.supplier_integrations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_integrations TO authenticated;

COMMENT ON TABLE public.supplier_integrations IS
  'Conectores de ERPs de fornecedores (dropship). access_token sempre encriptado AES-GCM.';
COMMENT ON COLUMN public.supplier_integrations.integration_type IS
  'Tipo do ERP. Atualmente só icarus (Pennacorp). Extensível pra bling/tiny/etc.';
COMMENT ON COLUMN public.supplier_integrations.config IS
  'Override de defaults: base_url (se não-padrão), rate_limit_rpm, sync_only_ecommerce, etc.';
