-- ML Ads — campaigns + per-day reports
-- Run in Supabase SQL Editor before deploying ML Ads module.

CREATE TABLE IF NOT EXISTS ml_ads_campaigns (
  id              TEXT PRIMARY KEY,
  advertiser_id   TEXT NOT NULL,
  name            TEXT,
  status          TEXT,
  daily_budget    DECIMAL(10,2),
  type            TEXT,
  start_date      DATE,
  end_date        DATE,
  synced_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_ads_campaigns_advertiser
  ON ml_ads_campaigns(advertiser_id);

CREATE TABLE IF NOT EXISTS ml_ads_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  TEXT NOT NULL REFERENCES ml_ads_campaigns(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  clicks       INT DEFAULT 0,
  impressions  INT DEFAULT 0,
  ctr          DECIMAL(5,4) DEFAULT 0,
  spend        DECIMAL(10,2) DEFAULT 0,
  conversions  INT DEFAULT 0,
  revenue      DECIMAL(10,2) DEFAULT 0,
  roas         DECIMAL(8,2) DEFAULT 0,
  acos         DECIMAL(5,4) DEFAULT 0,
  synced_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(campaign_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ml_ads_reports_date
  ON ml_ads_reports(date DESC);
CREATE INDEX IF NOT EXISTS idx_ml_ads_reports_campaign_date
  ON ml_ads_reports(campaign_id, date DESC);
