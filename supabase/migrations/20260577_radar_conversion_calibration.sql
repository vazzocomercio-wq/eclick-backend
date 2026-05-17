-- ════════════════════════════════════════════════════════════════════════════
-- e-Click Radar IA — MVP 2 / Motor 2 · calibração da conversão
-- ════════════════════════════════════════════════════════════════════════════
--
-- A demanda estimada de concorrente = visitas (coletadas) × conversão. A
-- conversão é calibrada no dado REAL da Vazzo: unidades vendidas próprias ÷
-- visitas próprias, numa janela de 30 dias.
--
-- Calibrada POR CATEGORIA; a linha com `category_id` NULL é a taxa org-wide,
-- usada como fallback pra categorias com pouco dado (estimativa M2.2 usa a
-- taxa da categoria se `confidence='ok'`, senão cai pra org-wide).
--
-- Gravada 1×/dia pelo calibrador no eclick-workers (passo do runDaily()).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.radar_conversion_calibration (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  calc_date        date NOT NULL DEFAULT CURRENT_DATE,
  category_id      text,                       -- NULL = taxa org-wide (fallback)
  window_days      int NOT NULL DEFAULT 30,
  own_items        int NOT NULL DEFAULT 0,
  own_visits       bigint NOT NULL DEFAULT 0,
  own_units        int NOT NULL DEFAULT 0,
  conversion_rate  numeric,                    -- own_units / own_visits; NULL sem visitas
  confidence       text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'ok')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT: garante 1 só linha org-wide (category_id NULL) por dia.
  CONSTRAINT radar_conversion_calibration_uniq
    UNIQUE NULLS NOT DISTINCT (organization_id, calc_date, category_id)
);

CREATE INDEX IF NOT EXISTS idx_radar_conversion_calibration_lookup
  ON public.radar_conversion_calibration (organization_id, category_id, calc_date DESC);

GRANT ALL ON TABLE public.radar_conversion_calibration TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_conversion_calibration TO authenticated;
ALTER TABLE public.radar_conversion_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_conversion_calibration_org ON public.radar_conversion_calibration
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

COMMENT ON TABLE public.radar_conversion_calibration IS
  'e-Click Radar IA Motor 2 — taxa de conversão calibrada (vendas próprias ÷ visitas próprias, 30d). Por categoria + linha org-wide (category_id NULL). Base da demanda estimada de concorrentes.';
