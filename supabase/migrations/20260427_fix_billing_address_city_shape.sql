-- Correção: billing_address.city shape real da ML é `city_name` STRING,
-- não objeto aninhado `city: { name }`. A migration anterior populou
-- city = NULL em todos os clientes pq o caminho `->'city'->>'name'`
-- retorna null nesse shape. Re-backfill com o caminho correto + trigger
-- atualizado.

-- 1. Re-backfill agora com o shape correto
UPDATE unified_customers uc
SET city  = COALESCE(uc.city,  latest.billing_address->>'city_name'),
    state = COALESCE(uc.state, latest.billing_address->'state'->>'name'),
    updated_at = now()
FROM (
  SELECT DISTINCT ON (organization_id, raw_data->'buyer'->>'id')
    organization_id,
    raw_data->'buyer'->>'id' AS ml_buyer_id,
    billing_address
  FROM orders
  WHERE billing_address IS NOT NULL
    AND raw_data->'buyer'->>'id' IS NOT NULL
  ORDER BY organization_id, raw_data->'buyer'->>'id', sold_at DESC NULLS LAST
) latest
WHERE uc.organization_id = latest.organization_id
  AND uc.ml_buyer_id     = latest.ml_buyer_id
  AND (uc.city IS NULL OR uc.state IS NULL);

-- 2. Trigger corrigido — só muda v_city pra ler ->>'city_name' direto
CREATE OR REPLACE FUNCTION sync_buyer_to_unified() RETURNS TRIGGER AS $$
DECLARE
  v_customer_id  UUID;
  v_buyer_ml_id  TEXT;
  v_nickname     TEXT;
  v_display_name TEXT;
  v_city         TEXT;
  v_state        TEXT;
BEGIN
  v_buyer_ml_id  := NEW.raw_data->'buyer'->>'id';
  v_nickname     := NEW.raw_data->'buyer'->>'nickname';
  v_display_name := COALESCE(
    NEW.buyer_name,
    NULLIF(TRIM(CONCAT(NEW.raw_data->'buyer'->>'first_name',' ',NEW.raw_data->'buyer'->>'last_name')),''),
    v_nickname
  );
  -- FIX: ML retorna `city_name` como string direta, não objeto aninhado.
  v_city  := NEW.billing_address->>'city_name';
  v_state := NEW.billing_address->'state'->>'name';

  IF NEW.buyer_doc_number IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM unified_customers
    WHERE cpf = NEW.buyer_doc_number AND organization_id = NEW.organization_id LIMIT 1;
  END IF;
  IF v_customer_id IS NULL AND v_buyer_ml_id IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM unified_customers
    WHERE ml_buyer_id = v_buyer_ml_id AND organization_id = NEW.organization_id LIMIT 1;
  END IF;

  IF v_customer_id IS NULL THEN
    INSERT INTO unified_customers (
      organization_id, display_name, ml_buyer_id, ml_nickname,
      cpf, cnpj, email, phone, city, state,
      first_contact_at, last_contact_at, last_channel, total_purchases
    ) VALUES (
      NEW.organization_id, v_display_name, v_buyer_ml_id, v_nickname,
      NEW.buyer_doc_number,
      CASE WHEN NEW.buyer_doc_type = 'CNPJ' THEN NEW.buyer_doc_number ELSE NULL END,
      NEW.buyer_email, NEW.buyer_phone, v_city, v_state,
      NEW.sold_at, NEW.sold_at, 'mercadolivre', COALESCE(NEW.sale_price, 0)
    )
    ON CONFLICT DO NOTHING;
  ELSE
    UPDATE unified_customers SET
      cpf  = COALESCE(cpf, NEW.buyer_doc_number),
      cnpj = COALESCE(cnpj, CASE WHEN NEW.buyer_doc_type = 'CNPJ' THEN NEW.buyer_doc_number ELSE NULL END),
      email       = COALESCE(email, NEW.buyer_email),
      phone       = COALESCE(phone, NEW.buyer_phone),
      ml_nickname = COALESCE(ml_nickname, v_nickname),
      city        = COALESCE(city,  v_city),
      state       = COALESCE(state, v_state),
      display_name = CASE
        WHEN NEW.buyer_name IS NOT NULL AND NEW.buyer_name <> ''
             AND (display_name IS NULL OR display_name = ml_buyer_id
                  OR display_name = ml_nickname OR display_name = v_nickname
                  OR display_name !~ ' ')
        THEN NEW.buyer_name ELSE display_name
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
