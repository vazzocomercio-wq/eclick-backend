-- Loja Própria — formulários editáveis → leads no Active (AG2).
--
-- Cada submissão de um formulário (seção `leadForm` do Store Builder v3)
-- é gravada aqui antes de ser empurrada pro Active CRM (contato + deal no
-- funil escolhido). Garante histórico/auditoria + retry se o push falhar.
--
-- Fluxo:
--   1. Vitrine POST /public/store/by-slug/:slug/lead → grava row (status
--      'received') + tenta push pro Active via bridge (create-lead).
--   2. Push OK → status 'pushed' + active_deal_id/active_contact_id.
--      Push falhou → status 'failed' + error (lojista pode reenviar).
--   3. Sem bridge configurado → status 'received' (fica na fila pro lojista).

CREATE TABLE IF NOT EXISTS public.storefront_leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  store_slug          text NOT NULL,

  -- De qual formulário veio (section.id no design v3) + rótulo amigável
  section_id          text,
  form_title          text,

  -- Destino no Active escolhido no editor do formulário
  pipeline_id         text NOT NULL,
  stage_id            text NOT NULL,
  assigned_to         text,            -- org_members.id (opcional)

  -- Dados submetidos: { name?, email?, phone?, message?, custom: {label:val} }
  fields              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Estado do push pro Active
  status              text NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received', 'pushed', 'failed')),
  active_deal_id      text,
  active_contact_id   text,
  push_error          text,
  pushed_at           timestamptz,

  client_ip_hash      text,            -- SHA-256 (anti-spam)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storefront_leads_org
  ON public.storefront_leads (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storefront_leads_status
  ON public.storefront_leads (organization_id, status, created_at DESC);

COMMENT ON TABLE public.storefront_leads IS
  'Submissões de formulários editáveis da Loja Própria. Empurradas pro Active CRM (contato + deal no funil).';

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.tg_storefront_leads_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_storefront_leads_touch ON public.storefront_leads;
CREATE TRIGGER trg_storefront_leads_touch
  BEFORE UPDATE ON public.storefront_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_storefront_leads_touch();

-- Grants (criação via _admin_exec_sql não herda)
GRANT ALL ON TABLE public.storefront_leads TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_leads TO authenticated;
