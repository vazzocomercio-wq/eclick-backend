-- Recompute counters dos items orfaos ja na DB
-- (sync ant criou items mas crashou antes de updateCampaignCounters)
WITH counts AS (
  SELECT
    campaign_id,
    count(*) FILTER (WHERE status='candidate') as candidates,
    count(*) FILTER (WHERE status='pending')   as pendings,
    count(*) FILTER (WHERE status='started')   as starteds,
    count(*) FILTER (WHERE status='finished')  as finisheds
  FROM ml_campaign_items
  GROUP BY campaign_id
)
UPDATE ml_campaigns
SET candidate_count = counts.candidates,
    pending_count   = counts.pendings,
    started_count   = counts.starteds,
    finished_count  = counts.finisheds
FROM counts
WHERE counts.campaign_id = ml_campaigns.id;
