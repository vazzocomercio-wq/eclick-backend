-- Pre-popula IDs do funil "Campanhas/Pomoção" do Vazzo na ml_campaigns_config.
-- Org Vazzo: 98ea944c-50bd-424d-9a57-d00a87a9525b
-- Pipeline: 9f5abb47-59bb-453f-86e5-f06e1a30c3cb
-- Stages: decisão / autorização / em campanha
-- Operação só pra essa org — outras lojas continuam vazias até preencherem.

UPDATE ml_campaigns_config
   SET active_pipeline_id              = '9f5abb47-59bb-453f-86e5-f06e1a30c3cb',
       active_stage_initial_id         = '33800f62-0795-461c-a416-3d638a94b4af',
       active_stage_pending_manager_id = 'a69a47ce-2fef-4e23-bf9c-09d1312557a1',
       active_stage_in_campaign_id     = '29c57fb9-f76f-4a6f-a9c3-f383d73c0f73'
 WHERE organization_id = '98ea944c-50bd-424d-9a57-d00a87a9525b'
   AND active_pipeline_id IS NULL;
