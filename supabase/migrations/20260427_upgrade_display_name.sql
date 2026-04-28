-- /clientes display_name upgrade
-- The original sync_buyer_to_unified used COALESCE(display_name, v_display_name)
-- which protected user-edited names BUT also locked nickname-only values
-- forever. Customers first seen with only nickname (e.g. "ANAL8257747")
-- never got upgraded when later orders carried the real billing name.
--
-- Fix: only preserve display_name when it differs from the current order's
-- nickname (= a real name). Upgrade when current value IS the nickname.

CREATE OR REPLACE FUNCTION sync_buyer_to_unified() RETURNS TRIGGER AS $$
DECLARE
  v_customer_id  UUID;
  v_buyer_ml_id  TEXT;
  v_nickname     TEXT;
  v_display_name TEXT;
BEGIN
  v_buyer_ml_id  := NEW.raw_data->'buyer'->>'id';
  v_nickname     := NEW.raw_data->'buyer'->>'nickname';
  v_display_name := COALESCE(
    NEW.buyer_name,
    NULLIF(TRIM(CONCAT(
      NEW.raw_data->'buyer'->>'first_name', ' ',
      NEW.raw_data->'buyer'->>'last_name'
    )), ''),
    v_nickname
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
      -- UPGRADE display_name when it's still the bare nickname; preserve
      -- otherwise (real names + user-edited values stay untouched).
      display_name    = CASE
        WHEN display_name IS NULL THEN v_display_name
        WHEN display_name = v_nickname AND v_display_name IS NOT NULL AND v_display_name != v_nickname
          THEN v_display_name
        ELSE display_name
      END,
      ml_buyer_id     = COALESCE(ml_buyer_id, v_buyer_ml_id),
      last_contact_at = GREATEST(last_contact_at, NEW.sold_at),
      total_purchases = total_purchases + COALESCE(NEW.sale_price, 0),
      updated_at      = now()
    WHERE id = v_customer_id;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[sync_buyer_to_unified] order=% : %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill: for unified_customers with no spaces in display_name (i.e. it
-- looks like a bare nickname), pull the latest order whose buyer_name has
-- a space (real name) and upgrade display_name. Heuristic-based since we
-- don't store the nickname separately on unified_customers.
WITH latest_named AS (
  SELECT DISTINCT ON (raw_data->'buyer'->>'id', organization_id)
    raw_data->'buyer'->>'id'                                AS ml_buyer_id,
    organization_id,
    COALESCE(
      buyer_name,
      NULLIF(TRIM(CONCAT(raw_data->'buyer'->>'first_name', ' ',
                         raw_data->'buyer'->>'last_name')), '')
    )                                                       AS real_name
  FROM orders
  WHERE COALESCE(
          buyer_name,
          NULLIF(TRIM(CONCAT(raw_data->'buyer'->>'first_name', ' ',
                             raw_data->'buyer'->>'last_name')), '')
        ) ~ ' '                                  -- contains a space → real name
    AND raw_data->'buyer'->>'id' IS NOT NULL
  ORDER BY raw_data->'buyer'->>'id', organization_id, sold_at DESC NULLS LAST
)
UPDATE unified_customers uc
SET display_name = ln.real_name,
    updated_at   = now()
FROM latest_named ln
WHERE uc.organization_id = ln.organization_id
  AND uc.ml_buyer_id     = ln.ml_buyer_id
  AND ln.real_name IS NOT NULL
  AND (uc.display_name IS NULL OR uc.display_name !~ ' ');
