-- ════════════════════════════════════════════════════════════════════════════
-- e-Click Radar IA — R2.1 · Log de rodadas de coleta
-- ════════════════════════════════════════════════════════════════════════════
--
-- Tabela de auditoria das rodadas do coletor (que roda no eclick-workers).
-- Dois usos:
--   1. Idempotência + catch-up do scheduler — antes de disparar uma rodada o
--      worker checa "já rodou hoje?" aqui (sobrevive a reboot do Railway sem
--      pular nem duplicar a rodada).
--   2. "Logging por rodada" da spec R2 (itens processados, erros, duração).
--
-- Multi-tenant (organization_id + RLS) — uma rodada por org por tipo.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.radar_collection_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_type        text NOT NULL CHECK (run_type IN ('daily', 'discovery')),
  status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  stats           jsonb,                       -- contadores por coletor (itens, erros, duração)
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Index pra o check de idempotência: "rodada completa de tipo X hoje, pra org Y?"
CREATE INDEX IF NOT EXISTS idx_radar_collection_runs_lookup
  ON public.radar_collection_runs (organization_id, run_type, status, started_at DESC);

GRANT ALL ON TABLE public.radar_collection_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.radar_collection_runs TO authenticated;
ALTER TABLE public.radar_collection_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_collection_runs_org ON public.radar_collection_runs
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

COMMENT ON TABLE public.radar_collection_runs IS
  'e-Click Radar IA — log de rodadas de coleta (daily/discovery). Base da idempotência e catch-up do scheduler do eclick-workers.';
