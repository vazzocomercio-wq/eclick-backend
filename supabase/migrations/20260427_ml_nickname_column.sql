-- /clientes display_name fix — armazenar ml_nickname separado e
-- atualizar trigger para preferir buyer_name vindo do billing_info.
--
-- Sintoma: rows com CPF preenchido continuavam com display_name =
-- "JOSERAIMUNDODOSSANTOSSANTA" (nickname ML) em vez do "José Raimundo
-- dos Santos" do billing. Causa: COALESCE(display_name, …) nas versões
-- anteriores do trigger preserva qualquer valor — inclusive nickname.

-- 1. Coluna ml_nickname (apelido ML preservado, nunca confunde com nome)
ALTER TABLE unified_customers
  ADD COLUMN IF NOT EXISTS ml_nickname TEXT;

-- 2. Backfill ml_nickname a partir da última ordem com nickname
UPDATE unified_customers uc
SET ml_nickname = sub.nickname
FROM (
  SELECT DISTINCT ON (organization_id, raw_data->'buyer'->>'id')
    organization_id,
    raw_data->'buyer'->>'id'        AS ml_buyer_id,
    raw_data->'buyer'->>'nickname'  AS nickname
  FROM orders
  WHERE raw_data->'buyer'->>'id'       IS NOT NULL
    AND raw_data->'buyer'->>'nickname' IS NOT NULL
  ORDER BY organization_id, raw_data->'buyer'->>'id', sold_at DESC NULLS LAST
) sub
WHERE uc.organization_id = sub.organization_id
  AND uc.ml_buyer_id     = sub.ml_buyer_id
  AND uc.ml_nickname IS NULL;

-- 3. Trigger novo — display_name prefere buyer_name quando atual é nickname
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
    NULLIF(TRIM(CONCAT(NEW.raw_data->'buyer'->>'first_name',' ',NEW.raw_data->'buyer'->>'last_name')),''),
    v_nickname
  );

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
      cpf, cnpj, email, phone,
      first_contact_at, last_contact_at, last_channel, total_purchases
    ) VALUES (
      NEW.organization_id,
      v_display_name,
      v_buyer_ml_id,
      v_nickname,
      NEW.buyer_doc_number,
      CASE WHEN NEW.buyer_doc_type = 'CNPJ' THEN NEW.buyer_doc_number ELSE NULL END,
      NEW.buyer_email, NEW.buyer_phone,
      NEW.sold_at, NEW.sold_at, 'mercadolivre',
      COALESCE(NEW.sale_price, 0)
    )
    ON CONFLICT DO NOTHING;
  ELSE
    UPDATE unified_customers SET
      cpf  = COALESCE(cpf, NEW.buyer_doc_number),
      cnpj = COALESCE(cnpj, CASE WHEN NEW.buyer_doc_type = 'CNPJ' THEN NEW.buyer_doc_number ELSE NULL END),
      email       = COALESCE(email, NEW.buyer_email),
      phone       = COALESCE(phone, NEW.buyer_phone),
      ml_nickname = COALESCE(ml_nickname, v_nickname),
      display_name = CASE
        WHEN NEW.buyer_name IS NOT NULL AND NEW.buyer_name <> ''
             AND (
               display_name IS NULL
               OR display_name = ml_buyer_id
               OR display_name = ml_nickname
               OR display_name = v_nickname
               OR display_name !~ ' '
             )
        THEN NEW.buyer_name
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

-- 4. Backfill display_name nas linhas com CPF que ainda mostram nickname
UPDATE unified_customers uc
SET display_name = o.buyer_name,
    updated_at = now()
FROM orders o
WHERE o.raw_data->'buyer'->>'id' = uc.ml_buyer_id
  AND o.organization_id = uc.organization_id
  AND o.buyer_name IS NOT NULL
  AND o.buyer_name <> ''
  AND uc.cpf IS NOT NULL
  AND (uc.display_name !~ ' ' OR uc.display_name = uc.ml_nickname);
