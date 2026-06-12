-- ─────────────────────────────────────────────────────────────────────────────
-- Consentimento LGPD pra CPF que chega DEPOIS do insert do pedido.
--
-- O enqueue_order_communication registra o consentimento (base contratual da
-- compra, Art. 7º V LGPD) no INSERT do pedido — mas só quando o CPF já está na
-- linha. Na Shopee o CPF é capturado na janela READY_TO_SHIP e pode chegar via
-- UPDATE: o cliente ganhava CPF sem consentimento e o hub de enriquecimento
-- (corretamente) recusava a consulta com zero tentativas.
--
-- Fix: sync_buyer_to_unified também registra o consentimento (idempotente)
-- sempre que processa um pedido com CPF. Backfill já executado:
-- INSERT em enrichment_consents pra clientes com CPF de pedido sem registro.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.sync_buyer_to_unified()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_customer_id  UUID;
  v_buyer_ml_id  TEXT;
  v_shopee_id    TEXT;
  v_nickname     TEXT;
  v_display_name TEXT;
  v_city         TEXT;
  v_state        TEXT;
  v_is_insert    BOOLEAN := (TG_OP = 'INSERT');
BEGIN
  -- Re-sync sem mudança nos campos de comprador = no-op
  IF TG_OP = 'UPDATE'
     AND OLD.buyer_doc_number IS NOT DISTINCT FROM NEW.buyer_doc_number
     AND OLD.buyer_email      IS NOT DISTINCT FROM NEW.buyer_email
     AND OLD.buyer_phone      IS NOT DISTINCT FROM NEW.buyer_phone
     AND OLD.buyer_name       IS NOT DISTINCT FROM NEW.buyer_name THEN
    RETURN NEW;
  END IF;

  v_buyer_ml_id := CASE WHEN NEW.source = 'mercadolivre'
                        THEN NEW.raw_data->'buyer'->>'id' END;
  v_shopee_id   := CASE WHEN NEW.source = 'shopee'
                        THEN COALESCE(NULLIF(NEW.raw_data->>'buyer_user_id',''),
                                      NULLIF(NEW.raw_data->>'buyer_username','')) END;
  v_nickname    := COALESCE(NEW.raw_data->'buyer'->>'nickname',
                            NULLIF(NEW.buyer_username,''),
                            NULLIF(NEW.raw_data->>'buyer_username',''));
  v_display_name := COALESCE(
    NULLIF(NEW.buyer_name,''),
    NULLIF(TRIM(CONCAT(NEW.raw_data->'buyer'->>'first_name',' ',NEW.raw_data->'buyer'->>'last_name')),''),
    v_nickname
  );
  IF v_display_name ~ '^\*+$' THEN v_display_name := v_nickname; END IF;

  v_city  := NEW.billing_address->'city'->>'name';
  v_state := NEW.billing_address->'state'->>'name';

  IF NEW.buyer_doc_number IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM unified_customers
    WHERE cpf = NEW.buyer_doc_number AND organization_id = NEW.organization_id LIMIT 1;
  END IF;
  IF v_customer_id IS NULL AND v_buyer_ml_id IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM unified_customers
    WHERE ml_buyer_id = v_buyer_ml_id AND organization_id = NEW.organization_id LIMIT 1;
  END IF;
  IF v_customer_id IS NULL AND v_shopee_id IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM unified_customers
    WHERE shopee_buyer_id = v_shopee_id AND organization_id = NEW.organization_id LIMIT 1;
  END IF;
  IF v_customer_id IS NULL AND NEW.buyer_email IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM unified_customers
    WHERE email = NEW.buyer_email AND organization_id = NEW.organization_id LIMIT 1;
  END IF;
  IF v_customer_id IS NULL AND NEW.buyer_phone IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM unified_customers
    WHERE phone = NEW.buyer_phone AND organization_id = NEW.organization_id LIMIT 1;
  END IF;

  IF v_customer_id IS NULL THEN
    IF NEW.buyer_doc_number IS NULL AND v_buyer_ml_id IS NULL AND v_shopee_id IS NULL
       AND NEW.buyer_email IS NULL AND NEW.buyer_phone IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO unified_customers (
      organization_id, display_name, ml_buyer_id, ml_nickname, shopee_buyer_id,
      cpf, cnpj, email, phone, city, state,
      first_contact_at, last_contact_at, last_channel, total_purchases
    ) VALUES (
      NEW.organization_id, v_display_name, v_buyer_ml_id, v_nickname, v_shopee_id,
      NEW.buyer_doc_number,
      CASE WHEN NEW.buyer_doc_type = 'CNPJ' THEN NEW.buyer_doc_number ELSE NULL END,
      NEW.buyer_email, NEW.buyer_phone, v_city, v_state,
      NEW.sold_at, NEW.sold_at, COALESCE(NEW.source, 'mercadolivre'),
      CASE WHEN v_is_insert THEN COALESCE(NEW.sale_price, 0) ELSE 0 END
    )
    ON CONFLICT DO NOTHING;
    -- recupera o id (criado agora ou em corrida concorrente)
    SELECT id INTO v_customer_id FROM unified_customers
    WHERE organization_id = NEW.organization_id
      AND (cpf = NEW.buyer_doc_number OR (v_shopee_id IS NOT NULL AND shopee_buyer_id = v_shopee_id))
    LIMIT 1;
  ELSE
    UPDATE unified_customers SET
      cpf  = COALESCE(cpf, NEW.buyer_doc_number),
      cnpj = COALESCE(cnpj, CASE WHEN NEW.buyer_doc_type = 'CNPJ' THEN NEW.buyer_doc_number ELSE NULL END),
      email       = COALESCE(email, NEW.buyer_email),
      phone       = COALESCE(phone, NEW.buyer_phone),
      ml_nickname = COALESCE(ml_nickname, v_nickname),
      shopee_buyer_id = COALESCE(shopee_buyer_id, v_shopee_id),
      city        = COALESCE(city,  v_city),
      state       = COALESCE(state, v_state),
      display_name = CASE
        WHEN v_display_name IS NOT NULL AND v_display_name <> ''
             AND (display_name IS NULL OR display_name = ml_buyer_id
                  OR display_name = ml_nickname OR display_name = v_nickname
                  OR display_name ~ '^\*+$' OR display_name !~ ' ')
        THEN v_display_name ELSE display_name
      END,
      ml_buyer_id     = COALESCE(ml_buyer_id, v_buyer_ml_id),
      last_contact_at = GREATEST(last_contact_at, NEW.sold_at),
      total_purchases = total_purchases + CASE WHEN v_is_insert THEN COALESCE(NEW.sale_price, 0) ELSE 0 END,
      updated_at      = now()
    WHERE id = v_customer_id;
  END IF;

  -- Consentimento LGPD (base contratual da compra, Art. 7º V) — cobre o CPF
  -- que chega DEPOIS do insert (captura Shopee na janela READY_TO_SHIP), que
  -- não passa pelo enqueue_order_communication. Idempotente.
  IF NEW.buyer_doc_number IS NOT NULL AND v_customer_id IS NOT NULL THEN
    INSERT INTO enrichment_consents (
      organization_id, customer_id, identifier_type, identifier_hash,
      consent_enrichment, consent_messaging_whatsapp, consent_marketing,
      consent_source, consent_at
    ) VALUES (
      NEW.organization_id, v_customer_id, 'cpf',
      encode(sha256(convert_to(NEW.buyer_doc_number, 'UTF8')), 'hex'),
      true, true, false, 'order_purchase_contract_art7v', now()
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[sync_buyer_to_unified] order=% : %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;
