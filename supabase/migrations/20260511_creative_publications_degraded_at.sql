-- Sprint F6 — IA Criativo (melhoria #8: alerta de degradação)
--
-- Quando F4 sync detecta status do ML mudando de 'active' pra
-- 'inactive', 'closed', 'under_review' ou 'payment_required',
-- considera o anúncio "degradado" e seta degraded_at.
--
-- UI mostra alerta na PublicationRow + botão de "regerar nova
-- versão" pro user agir manualmente. Sem auto-publish (sempre
-- mantém disciplina "paused" — user revisa antes de ativar).

ALTER TABLE creative_publications
  ADD COLUMN IF NOT EXISTS degraded_at             timestamptz,
  ADD COLUMN IF NOT EXISTS degraded_from_status    text,
  ADD COLUMN IF NOT EXISTS degraded_to_status      text,
  ADD COLUMN IF NOT EXISTS degradation_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS degradation_acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Index pra UI buscar degradações não-tratadas rapidamente
CREATE INDEX IF NOT EXISTS idx_creative_publications_degraded
  ON creative_publications(organization_id, degraded_at DESC)
  WHERE degraded_at IS NOT NULL AND degradation_acknowledged_at IS NULL;
