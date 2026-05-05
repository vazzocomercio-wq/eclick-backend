-- COM-1.6: multi-tenant fix em whatsapp_config (Z-API / Meta Cloud)
-- Schema original tinha apenas user_id (FK pra auth.users), sem
-- organization_id. Significa que duas orgs do mesmo user dividiam a
-- mesma config — bloqueador de prod 2º cliente.
--
-- Backfill: pega organization_id via organization_members(user_id).
-- Quando user pertence a múltiplas orgs, usa a 1ª (ordenado por
-- created_at). Em prod atual há 1 org por user, então é seguro.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS organization_id UUID;

-- Backfill via membership
UPDATE whatsapp_config wc
   SET organization_id = (
     SELECT organization_id FROM organization_members om
      WHERE om.user_id = wc.user_id
      ORDER BY om.created_at ASC
      LIMIT 1
   )
 WHERE wc.organization_id IS NULL;

-- Limpa órfãos (user sem membership ou row corrompida)
DELETE FROM whatsapp_config WHERE organization_id IS NULL;

-- Trava NOT NULL + FK
ALTER TABLE whatsapp_config
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_organization_id_fkey;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

-- Index pra queries por org+ativa
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_org_active
  ON whatsapp_config(organization_id, is_active);

-- RLS por organization_members
ALTER TABLE whatsapp_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_config_org ON whatsapp_config;
CREATE POLICY whatsapp_config_org ON whatsapp_config FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT ALL ON whatsapp_config TO service_role;
