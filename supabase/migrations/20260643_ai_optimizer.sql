-- AI Visibility OS — geo-optimizer Dia 10: rascunhos de otimização.
--
-- Guarda as variações de título + descrição reescrita geradas pela IA (status
-- draft). Publicação no marketplace + versionamento (ai_optimizer_versions) e
-- FAQ/schema vêm nos Dias 11-12. Multi-tenant + GRANT só service_role (leitura
-- via backend gated, igual ai_audit_*).

CREATE TABLE IF NOT EXISTS public.ai_optimizer_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id           uuid REFERENCES public.ai_audit_jobs(id) ON DELETE SET NULL, -- auditoria que embasou (pode ser null)
  url              text NOT NULL,
  platform         varchar(30),
  title_variations jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{variant,type,title,reasoning,target_query,estimated_geo_lift}]
  description_old  text,                                  -- versão atual (pra rollback)
  description_new  text,
  faq_generated    jsonb NOT NULL DEFAULT '[]'::jsonb,    -- Dia 11
  schema_jsonld    text,                                  -- Dia 11
  status           varchar(20) NOT NULL DEFAULT 'draft',  -- draft|approved|applied|rolled_back
  cost_usd         numeric(10,4) NOT NULL DEFAULT 0,
  applied_at       timestamptz,
  rolled_back_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aor_org_time ON public.ai_optimizer_results (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aor_job      ON public.ai_optimizer_results (job_id);

ALTER TABLE public.ai_optimizer_results ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.ai_optimizer_results TO service_role;

COMMENT ON TABLE public.ai_optimizer_results IS
  'Rascunhos de otimização GEO (títulos A/B/C + descrição reescrita). Publicação/versionamento nos Dias 11-12.';

-- ============================================================
-- ROLLBACK: DROP TABLE IF EXISTS public.ai_optimizer_results;
-- ============================================================
