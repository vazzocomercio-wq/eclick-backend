-- Marketplace Buyer Enrichment Bridge — phase 1 SQL
-- Pulls billing info from ML, populates unified_customers via trigger,
-- backfills the existing 13.5k orders.

-- 1. Add billing columns to orders ──────────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS buyer_doc_type TEXT,
  ADD COLUMN IF NOT EXISTS buyer_doc_number TEXT,
  ADD COLUMN IF NOT EXISTS buyer_email TEXT,
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT,
  ADD COLUMN IF NOT EXISTS buyer_name TEXT,
  ADD COLUMN IF NOT EXISTS buyer_billing_fetched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_buyer_doc
  ON orders(buyer_doc_number) WHERE buyer_doc_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_buyer_billing_fetch
  ON orders(buyer_billing_fetched_at NULLS FIRST);

-- 2. Trigger — propagates each order's buyer into unified_customers ─────────
-- Wrapped in EXCEPTION WHEN OTHERS so a failure here NEVER rolls back the
-- order INSERT/UPDATE.
CREATE OR REPLACE FUNCTION sync_buyer_to_unified() RETURNS TRIGGER AS $$
DECLARE
  v_customer_id  UUID;
  v_buyer_ml_id  TEXT;
  v_display_name TEXT;
BEGIN
  v_buyer_ml_id  := NEW.raw_data->'buyer'->>'id';
  v_display_name := COALESCE(
    NEW.buyer_name,
    NULLIF(TRIM(CONCAT(
      NEW.raw_data->'buyer'->>'first_name', ' ',
      NEW.raw_data->'buyer'->>'last_name'
    )), ''),
    NEW.raw_data->'buyer'->>'nickname'
  );

  -- 1. Match by CPF first (strongest identifier)
  IF NEW.buyer_doc_number IS NOT NULL THEN
    SELECT id INTO v_customer_id
    FROM unified_customers
    WHERE cpf = NEW.buyer_doc_number
      AND organization_id = NEW.organization_id
    LIMIT 1;
  END IF;

  -- 2. Else match by ml_buyer_id
  IF v_customer_id IS NULL AND v_buyer_ml_id IS NOT NULL THEN
    SELECT id INTO v_customer_id
    FROM unified_customers
    WHERE ml_buyer_id = v_buyer_ml_id
      AND organization_id = NEW.organization_id
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL THEN
    INSERT INTO unified_customers (
      organization_id, display_name, ml_buyer_id,
      cpf, email, phone,
      first_contact_at, last_contact_at, last_channel,
      total_purchases
    ) VALUES (
      NEW.organization_id,
      v_display_name,
      v_buyer_ml_id,
      NEW.buyer_doc_number,
      NEW.buyer_email,
      NEW.buyer_phone,
      NEW.sold_at, NEW.sold_at, 'mercadolivre',
      COALESCE(NEW.sale_price, 0)
    )
    ON CONFLICT DO NOTHING;
  ELSE
    UPDATE unified_customers SET
      cpf             = COALESCE(cpf, NEW.buyer_doc_number),
      email           = COALESCE(email, NEW.buyer_email),
      phone           = COALESCE(phone, NEW.buyer_phone),
      display_name    = COALESCE(display_name, v_display_name),
      ml_buyer_id     = COALESCE(ml_buyer_id, v_buyer_ml_id),
      last_contact_at = GREATEST(last_contact_at, NEW.sold_at),
      total_purchases = total_purchases + COALESCE(NEW.sale_price, 0),
      updated_at      = now()
    WHERE id = v_customer_id;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[sync_buyer_to_unified] order=% : %', NEW.id, SQLERRM;
  RETURN NEW; -- never block the order write
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_buyer ON orders;
CREATE TRIGGER trg_sync_buyer
  AFTER INSERT OR UPDATE OF buyer_doc_number, buyer_email, buyer_phone, buyer_name ON orders
  FOR EACH ROW EXECUTE FUNCTION sync_buyer_to_unified();

-- 3. Backfill — one row per (org, ml_buyer_id) for existing orders ─────────
INSERT INTO unified_customers (
  organization_id, display_name, ml_buyer_id,
  first_contact_at, last_contact_at, last_channel, total_purchases
)
SELECT
  o.organization_id,
  MAX(COALESCE(o.buyer_name,
               NULLIF(TRIM(CONCAT(o.raw_data->'buyer'->>'first_name', ' ',
                                  o.raw_data->'buyer'->>'last_name')), ''),
               o.raw_data->'buyer'->>'nickname')) AS display_name,
  o.raw_data->'buyer'->>'id' AS ml_buyer_id,
  MIN(o.sold_at), MAX(o.sold_at), 'mercadolivre',
  COALESCE(SUM(o.sale_price), 0)
FROM orders o
WHERE o.raw_data->'buyer'->>'id' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM unified_customers uc
    WHERE uc.organization_id = o.organization_id
      AND uc.ml_buyer_id = o.raw_data->'buyer'->>'id'
  )
GROUP BY o.organization_id, o.raw_data->'buyer'->>'id';
