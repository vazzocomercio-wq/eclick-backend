-- Pre-popula config M4 pra Vazzo (org_id 4ef1aabd... no SaaS).
-- Active org_id: 98ea944c-50bd-424d-9a57-d00a87a9525b (mapeamento)
-- Pipeline + 3 stages do funil "Campanhas/Pomoção" no Active.
-- Faz UPSERT pra cada seller_id conhecido.

INSERT INTO ml_campaigns_config (
  organization_id, seller_id,
  active_org_id,
  active_pipeline_id,
  active_stage_initial_id,
  active_stage_pending_manager_id,
  active_stage_in_campaign_id
)
VALUES
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 2290161131,
   '98ea944c-50bd-424d-9a57-d00a87a9525b',
   '9f5abb47-59bb-453f-86e5-f06e1a30c3cb',
   '33800f62-0795-461c-a416-3d638a94b4af',
   'a69a47ce-2fef-4e23-bf9c-09d1312557a1',
   '29c57fb9-f76f-4a6f-a9c3-f383d73c0f73'),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 3067855333,
   '98ea944c-50bd-424d-9a57-d00a87a9525b',
   '9f5abb47-59bb-453f-86e5-f06e1a30c3cb',
   '33800f62-0795-461c-a416-3d638a94b4af',
   'a69a47ce-2fef-4e23-bf9c-09d1312557a1',
   '29c57fb9-f76f-4a6f-a9c3-f383d73c0f73')
ON CONFLICT (organization_id, seller_id) DO UPDATE
SET active_org_id                    = EXCLUDED.active_org_id,
    active_pipeline_id               = EXCLUDED.active_pipeline_id,
    active_stage_initial_id          = EXCLUDED.active_stage_initial_id,
    active_stage_pending_manager_id  = EXCLUDED.active_stage_pending_manager_id,
    active_stage_in_campaign_id      = EXCLUDED.active_stage_in_campaign_id,
    updated_at                       = now();
