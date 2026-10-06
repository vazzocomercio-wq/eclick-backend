-- Product OS / Farm — de qual PRODUTO é o job que a impressora está rodando.
-- A telemetria da Bambu só traz o nome do arquivo (subtask_name). Quando o job não veio de uma
-- ordem de produção, casamos o nome com um produto (regra → IA → ajuste manual) e guardamos aqui,
-- para o Mapa da farm mostrar a imagem do produto em cada posição.
CREATE TABLE IF NOT EXISTS public.farm_job_product_match (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_key          text NOT NULL,                       -- nome do job normalizado (minúsculo, sem extensão)
  job_name         text NOT NULL,                       -- como veio da impressora (último visto)
  product_dev_id   uuid REFERENCES public.product_dev(id) ON DELETE SET NULL,   -- NULL = não identificado
  source           text NOT NULL CHECK (source IN ('op', 'regra', 'ia', 'manual')),
  confidence       numeric(4,3),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, job_key)
);
CREATE INDEX IF NOT EXISTS farm_job_product_match_org_idx ON public.farm_job_product_match (organization_id, updated_at DESC);
ALTER TABLE public.farm_job_product_match ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS farm_job_product_match_org ON public.farm_job_product_match;
CREATE POLICY farm_job_product_match_org ON public.farm_job_product_match
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));
GRANT ALL ON TABLE public.farm_job_product_match TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.farm_job_product_match TO authenticated;
