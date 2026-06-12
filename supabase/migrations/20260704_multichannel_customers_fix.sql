-- ─────────────────────────────────────────────────────────────────────────────
-- Pedidos multi-canal: unificação de clientes channel-aware + fim da fábrica
-- de clientes duplicados.
--
-- PROBLEMA: sync_buyer_to_unified (trigger em orders) só conhecia CPF e
-- ml_buyer_id como identidade. Pedido Shopee/TikTok sem CPF → INSERT novo
-- cliente A CADA disparo; e o trigger dispara em TODO upsert do cron (Shopee
-- re-varre a janela a cada 1h) porque o UPDATE inclui buyer_* no SET mesmo
-- sem mudança de valor. Resultado: ~39 mil unified_customers sem nenhum
-- identificador (ex: "Silvio José Alves Junior" ×5639, "****" ×5468), e
-- total_purchases inflando a cada re-sync.
--
-- FIX:
--  1. UPDATE sem mudança real nos campos de comprador = no-op.
--  2. Identidade por canal: cpf → ml_buyer_id → shopee_buyer_id (user_id/
--     username do raw) → email → phone.
--  3. Sem NENHUM identificador → não cria cliente (nada pra deduplicar).
--  4. total_purchases só soma no INSERT do pedido (não no re-sync).
--  5. Mascarados da Shopee ('****') tratados como null.
--  6. Limpeza: soft-delete dos clientes zero-identificador sem conversas/notas.
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
  -- Re-sync sem mudança nos campos de comprador = no-op (cron Shopee/TikTok
  -- re-varre a janela e faz upsert com os MESMOS valores a cada ciclo).
  IF TG_OP = 'UPDATE'
     AND OLD.buyer_doc_number IS NOT DISTINCT FROM NEW.buyer_doc_number
     AND OLD.buyer_email      IS NOT DISTINCT FROM NEW.buyer_email
     AND OLD.buyer_phone      IS NOT DISTINCT FROM NEW.buyer_phone
     AND OLD.buyer_name       IS NOT DISTINCT FROM NEW.buyer_name THEN
    RETURN NEW;
  END IF;

  v_buyer_ml_id := CASE WHEN NEW.source = 'mercadolivre'
                        THEN NEW.raw_data->'buyer'->>'id' END;
  -- Shopee: user_id numérico (estável) > username (sempre aberto no raw)
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
  -- Shopee mascara dados sensíveis ('****') quando o app não tem o acesso —
  -- nunca usar máscara como nome.
  IF v_display_name ~ '^\*+$' THEN v_display_name := v_nickname; END IF;

  v_city  := NEW.billing_address->'city'->>'name';
  v_state := NEW.billing_address->'state'->>'name';

  -- Identidade em ordem de força
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
    -- SEM identificador estável → não cria. (Era a fábrica de duplicados:
    -- cliente sem cpf/ml/shopee/email/fone não tem como ser deduplicado.)
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
      -- compra só conta quando o PEDIDO é inserido (não a cada re-sync)
      total_purchases = total_purchases + CASE WHEN v_is_insert THEN COALESCE(NEW.sale_price, 0) ELSE 0 END,
      updated_at      = now()
    WHERE id = v_customer_id;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[sync_buyer_to_unified] order=% : %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- ── Limpeza: soft-delete do lixo zero-identificador criado pelo bug ─────────
UPDATE unified_customers SET is_deleted = true, deleted_at = now()
WHERE is_deleted = false
  AND cpf IS NULL AND phone IS NULL AND email IS NULL AND whatsapp_id IS NULL
  AND COALESCE(ml_buyer_id, '') = '' AND COALESCE(shopee_buyer_id, '') = ''
  AND COALESCE(total_conversations, 0) = 0 AND notes IS NULL;
