-- M4 — fix: SaaS e Active têm DBs separadas, org UUIDs diferentes.
-- Adiciona active_org_id pra mapear SaaS org → Active org no bridge.
-- Quando vazio, sistema usa o próprio organization_id (compat com legacy).

ALTER TABLE ml_campaigns_config
  ADD COLUMN IF NOT EXISTS active_org_id uuid;
