-- 20260711 — Playbook IA de Devoluções (Shopee).
-- ADITIVO sobre marketplace_returns (outra sessão usa a mesma tabela com
-- prefixo sac_ — aqui só colunas playbook_*, NUNCA alterar as existentes).
-- + tabela de config por org (modo auto opt-in, tetos).

ALTER TABLE public.marketplace_returns
  ADD COLUMN IF NOT EXISTS playbook_action        text,         -- accept | accept_offer | dispute | collect_evidence | monitor
  ADD COLUMN IF NOT EXISTS playbook_rationale     text,         -- racional em PT-BR (mostrado no drawer)
  ADD COLUMN IF NOT EXISTS playbook_confidence    numeric,      -- 0..1
  ADD COLUMN IF NOT EXISTS playbook_processed_at  timestamptz,  -- quando o motor analisou
  ADD COLUMN IF NOT EXISTS playbook_meta          jsonb NOT NULL DEFAULT '{}'::jsonb, -- economics + classificação IA + dossiê
  ADD COLUMN IF NOT EXISTS playbook_executed_action text,       -- ação realmente executada via API
  ADD COLUMN IF NOT EXISTS playbook_executed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS playbook_executed_by   text;         -- user id (ou 'auto')

CREATE INDEX IF NOT EXISTS idx_mp_returns_playbook_pending
  ON public.marketplace_returns (organization_id, playbook_processed_at)
  WHERE status IN ('REQUESTED','PROCESSING','JUDGING');

-- Config por org do modo automático (Fase D — opt-in, nasce desligado).
CREATE TABLE IF NOT EXISTS public.returns_playbook_config (
  organization_id        uuid PRIMARY KEY REFERENCES public.organizations(id),
  enabled                boolean NOT NULL DEFAULT false,  -- modo AUTO (aceite automático)
  auto_accept_max_amount numeric NOT NULL DEFAULT 0,      -- teto R$ p/ auto-aceite (0 = nunca)
  reverse_shipping_cost  numeric NOT NULL DEFAULT 20,     -- custo estimado do frete reverso (R$)
  handling_cost          numeric NOT NULL DEFAULT 5,      -- custo de manuseio/reestoque (R$)
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- GRANTs explícitos (tabela via _admin_exec_sql não herda default privileges).
GRANT ALL ON TABLE public.returns_playbook_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.returns_playbook_config TO authenticated;

ALTER TABLE public.returns_playbook_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS returns_playbook_config_org_isolation ON public.returns_playbook_config;
CREATE POLICY returns_playbook_config_org_isolation ON public.returns_playbook_config
  FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members
    WHERE user_id = auth.uid()
  ));
