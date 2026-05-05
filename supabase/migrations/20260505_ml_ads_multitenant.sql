-- Multi-tenant fix pro ML Ads
-- Schema original (20260427_ml_ads.sql) não tinha organization_id em
-- ml_ads_campaigns nem ml_ads_reports — todas as orgs do SaaS dividiam
-- as mesmas tabelas. Bug crítico pra produção multi-cliente.
--
-- Backfill: stamp organization_id via match advertiser_id (text) ↔
-- seller_id (bigint) em ml_connections. Linhas sem match são deletadas
-- (provavelmente dados de teste anteriores ao multi-tenant).

-- ─────────────────────────────────────────────────────────────────────
-- 1.1  ml_ads_campaigns
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE ml_ads_campaigns
  ADD COLUMN IF NOT EXISTS organization_id UUID;

-- Backfill: cruza advertiser_id (text) com ml_connections.seller_id (bigint).
-- Em produção atual há 1 org só, então isso captura tudo. Pra dados de
-- testes antigos que não batem com nenhuma conexão, deletamos.
UPDATE ml_ads_campaigns c
   SET organization_id = mc.organization_id
  FROM ml_connections mc
 WHERE c.advertiser_id = mc.seller_id::text
   AND c.organization_id IS NULL;

-- Limpa órfãos (advertiser_id sem conexão associada)
DELETE FROM ml_ads_campaigns WHERE organization_id IS NULL;

-- Trava NOT NULL + FK
ALTER TABLE ml_ads_campaigns
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE ml_ads_campaigns
  DROP CONSTRAINT IF EXISTS ml_ads_campaigns_organization_id_fkey;
ALTER TABLE ml_ads_campaigns
  ADD CONSTRAINT ml_ads_campaigns_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

-- Index pra queries por org
CREATE INDEX IF NOT EXISTS idx_ml_ads_campaigns_org
  ON ml_ads_campaigns(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_ml_ads_campaigns_org_advertiser
  ON ml_ads_campaigns(organization_id, advertiser_id);

-- ─────────────────────────────────────────────────────────────────────
-- 1.2  ml_ads_reports
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE ml_ads_reports
  ADD COLUMN IF NOT EXISTS organization_id UUID;

-- Reports herdam organization_id do campaign correspondente.
UPDATE ml_ads_reports r
   SET organization_id = c.organization_id
  FROM ml_ads_campaigns c
 WHERE c.id = r.campaign_id
   AND r.organization_id IS NULL;

-- Reports cujo campaign foi deletado (cascade já fez), drop pelos restantes.
DELETE FROM ml_ads_reports WHERE organization_id IS NULL;

ALTER TABLE ml_ads_reports
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE ml_ads_reports
  DROP CONSTRAINT IF EXISTS ml_ads_reports_organization_id_fkey;
ALTER TABLE ml_ads_reports
  ADD CONSTRAINT ml_ads_reports_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ml_ads_reports_org_date
  ON ml_ads_reports(organization_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_ml_ads_reports_org_campaign
  ON ml_ads_reports(organization_id, campaign_id, date DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 1.3  RLS + grants
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE ml_ads_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_ads_reports   ENABLE ROW LEVEL SECURITY;

-- Policies por org via organization_members
DROP POLICY IF EXISTS ml_ads_campaigns_org ON ml_ads_campaigns;
CREATE POLICY ml_ads_campaigns_org ON ml_ads_campaigns FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS ml_ads_reports_org ON ml_ads_reports;
CREATE POLICY ml_ads_reports_org ON ml_ads_reports FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
  ));

-- Service role bypass
GRANT ALL ON ml_ads_campaigns TO service_role;
GRANT ALL ON ml_ads_reports   TO service_role;
