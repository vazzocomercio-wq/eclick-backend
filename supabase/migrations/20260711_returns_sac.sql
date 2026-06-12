-- 20260711 — Devolução → ticket no CRM (SAC).
-- Toda devolução aberta vira card no funil "SAC — Devoluções" do Active e o
-- card avança sozinho quando o status muda. Colunas ADITIVAS com prefixo sac_
-- (a sessão do Playbook IA também usa marketplace_returns — não tocar no resto).

ALTER TABLE public.marketplace_returns
  ADD COLUMN IF NOT EXISTS sac_deal_id     text,         -- card criado no Active (deals.id)
  ADD COLUMN IF NOT EXISTS sac_synced_at   timestamptz,  -- última sincronização com o funil
  ADD COLUMN IF NOT EXISTS sac_last_status text;         -- status na última sync (detecta mudança)

-- ── cache do funil por organização ──────────────────────────────────────────
-- Espelha o pattern da review_central_config: ensureServicePipeline roda 1x e
-- o resultado (pipeline + etapas com ids) fica cacheado aqui.
CREATE TABLE IF NOT EXISTS public.returns_sac_config (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  active_org_id   uuid,            -- org do Active (null = resolve por saas_org_id)
  pipeline_id     text,            -- funil "SAC — Devoluções"
  stages          jsonb,           -- [{id,name}] das 4 etapas
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- GRANTs explícitos: tabela criada via _admin_exec_sql NÃO herda os default
-- privileges do Supabase (sem isso até service_role bate em permission denied).
GRANT ALL ON TABLE public.returns_sac_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.returns_sac_config TO authenticated;

ALTER TABLE public.returns_sac_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS returns_sac_config_org_isolation ON public.returns_sac_config;
CREATE POLICY returns_sac_config_org_isolation ON public.returns_sac_config
  FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));
