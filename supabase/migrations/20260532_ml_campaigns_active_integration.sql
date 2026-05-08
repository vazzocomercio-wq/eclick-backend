-- M4 — Integração Campaign Center IA × Active (cards + tasks)
-- ════════════════════════════════════════════════════════════════════════
-- Adiciona em ml_campaigns_config os IDs do funil/estágios/responsável do
-- Active. Quando preenchidos, MlCampaignsAlertsService chama o
-- automation-bridge.createCampaignCard junto com cada deadline alert.
--
-- Vazios = M4 desligado (sistema só manda WhatsApp, comportamento atual).

ALTER TABLE ml_campaigns_config
  -- Pipeline + estágios do funil "Campanhas/Promoção" no Active
  ADD COLUMN IF NOT EXISTS active_pipeline_id              uuid,
  ADD COLUMN IF NOT EXISTS active_stage_initial_id         uuid,   -- "Aguardando decisão"
  ADD COLUMN IF NOT EXISTS active_stage_pending_manager_id uuid,   -- "Aguardando autorização"
  ADD COLUMN IF NOT EXISTS active_stage_in_campaign_id     uuid,   -- "Em campanha"
  -- Quem fica dono dos cards + tasks criados (auth.users.id no Active)
  ADD COLUMN IF NOT EXISTS active_assigned_to              uuid;
