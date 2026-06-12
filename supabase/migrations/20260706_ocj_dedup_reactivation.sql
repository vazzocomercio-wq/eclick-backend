-- 20260706 — Pós-venda multi-canal: dedup de OCJ por pedido externo +
-- reativação de jornadas bloqueadas quando o contato chega DEPOIS.
--
-- Contexto: `orders` é 1 linha por SKU → pedido multi-SKU disparava N OCJs
-- (e N mensagens iguais — caso real: ML 2000016268572528 recebeu 2× o mesmo
-- template). E na Shopee o CPF só aparece na janela READY_TO_SHIP (depois do
-- INSERT) → o OCJ morria em blocked_no_contact sem nunca reprocessar.
--
-- 3 peças:
--   1. enqueue_order_communication: não cria 2º OCJ pro mesmo pedido externo.
--   2. trigger em orders: CPF chegou (null→valor) → reativa OCJ bloqueado
--      com snapshot atualizado (só pedido recente e não cancelado).
--   3. trigger em unified_customers: fone/email chegou (null→valor) → reativa
--      OCJs bloqueados recentes desse cliente (cobre enriquecimento manual).

-- ─── 1. Índice de apoio pro dedup por pedido externo ───────────────────────
CREATE INDEX IF NOT EXISTS idx_ocj_org_journey_ext_order
  ON public.order_communication_journeys
  (organization_id, journey_id, (trigger_snapshot->>'external_order_id'));

-- Índices pros novos triggers (lookup por order_id / customer_id + state)
CREATE INDEX IF NOT EXISTS idx_ocj_order_state
  ON public.order_communication_journeys (order_id, state);
CREATE INDEX IF NOT EXISTS idx_ocj_customer_state
  ON public.order_communication_journeys (customer_id, state)
  WHERE customer_id IS NOT NULL;

-- ─── 2. enqueue com dedup por pedido externo ───────────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_order_communication(p_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order       orders%ROWTYPE;
  v_settings    organization_communication_settings%ROWTYPE;
  v_journey_id  uuid;
  v_ocj_id      uuid;
  v_snapshot    jsonb;
  v_customer_id uuid;
  v_cpf_clean   text;
  v_cpf_hash    text;
BEGIN
  -- 1. Carrega pedido
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 2. Verifica toggle global
  SELECT * INTO v_settings
  FROM organization_communication_settings
  WHERE organization_id = v_order.organization_id;
  IF NOT FOUND OR v_settings.auto_communication_enabled IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  -- 3. Busca jornada ativa
  SELECT id INTO v_journey_id
  FROM messaging_journeys
  WHERE organization_id = v_order.organization_id
    AND is_active = true
    AND trigger_event = 'order_created'
  ORDER BY created_at ASC
  LIMIT 1;
  IF v_journey_id IS NULL THEN RETURN NULL; END IF;

  -- 3.5 DEDUP por pedido EXTERNO: pedido multi-SKU vira N linhas em orders
  -- (uuids distintos) — sem este guard cada linha criava um OCJ próprio e o
  -- cliente recebia a mesma mensagem N vezes.
  IF v_order.external_order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM order_communication_journeys
    WHERE organization_id = v_order.organization_id
      AND journey_id      = v_journey_id
      AND trigger_snapshot->>'external_order_id' = v_order.external_order_id
  ) THEN
    RETURN NULL;
  END IF;

  -- 4. Resolve customer_id via CPF (SELECT → INSERT se não existir)
  IF v_order.buyer_doc_number IS NOT NULL THEN
    v_cpf_clean := regexp_replace(v_order.buyer_doc_number, '\D', '', 'g');

    SELECT id INTO v_customer_id
    FROM unified_customers
    WHERE organization_id = v_order.organization_id
      AND cpf = v_cpf_clean
    LIMIT 1;

    IF v_customer_id IS NULL THEN
      INSERT INTO unified_customers (
        organization_id, display_name, cpf, created_at, updated_at
      ) VALUES (
        v_order.organization_id,
        v_order.buyer_name,
        v_cpf_clean,
        now(), now()
      )
      RETURNING id INTO v_customer_id;
    END IF;

    -- 5. Registra consent de enrichment (base contratual Art.7 V LGPD)
    IF v_customer_id IS NOT NULL THEN
      v_cpf_hash := encode(sha256(convert_to(v_cpf_clean, 'UTF8')), 'hex');

      INSERT INTO enrichment_consents (
        organization_id, customer_id, identifier_type,
        identifier_hash, consent_enrichment,
        consent_messaging_whatsapp, consent_marketing,
        consent_source, consent_at
      ) VALUES (
        v_order.organization_id, v_customer_id, 'cpf',
        v_cpf_hash, true, true, false,
        'order_purchase_contract_art7v', now()
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  -- 6. Snapshot do pedido
  v_snapshot := jsonb_build_object(
    'external_order_id', v_order.external_order_id,
    'source',            v_order.source,
    'platform',          v_order.platform,
    'product_title',     v_order.product_title,
    'sku',               v_order.sku,
    'quantity',          v_order.quantity,
    'sale_price',        v_order.sale_price,
    'buyer_name',        v_order.buyer_name,
    'buyer_doc_number',  v_order.buyer_doc_number,
    'buyer_doc_type',    v_order.buyer_doc_type,
    'buyer_email',       v_order.buyer_email,
    'buyer_phone',       v_order.buyer_phone,
    'sold_at',           v_order.sold_at,
    'shipping_status',   v_order.shipping_status,
    'shipping_id',       v_order.shipping_id
  );

  -- 7. Cria journey (idempotente)
  INSERT INTO order_communication_journeys (
    organization_id, order_id, journey_id,
    customer_id, state, trigger_snapshot
  ) VALUES (
    v_order.organization_id, p_order_id, v_journey_id,
    v_customer_id, 'pending', v_snapshot
  )
  ON CONFLICT (order_id, journey_id) DO NOTHING
  RETURNING id INTO v_ocj_id;

  RETURN v_ocj_id;
END;
$function$;

-- ─── 3. Reativação quando o CPF chega no PEDIDO (captura na janela) ────────
-- Shopee: cron de ingestão captura buyer_cpf_id durante READY_TO_SHIP e faz
-- UPDATE null→valor. ML: billing-info também chega depois do INSERT.
-- Guard de 7 dias: backfill em massa de pedidos antigos NÃO acorda jornadas.
CREATE OR REPLACE FUNCTION public.reactivate_ocj_on_cpf()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF COALESCE(NEW.status, '') = 'cancelled'
       OR COALESCE(NEW.shipping_status, '') = 'cancelled' THEN
      RETURN NEW;
    END IF;
    IF NEW.sold_at IS NULL OR NEW.sold_at < now() - interval '7 days' THEN
      RETURN NEW;
    END IF;

    UPDATE order_communication_journeys ocj SET
      state            = 'pending',
      stopped_reason   = NULL,
      last_error       = NULL,
      -- refresh do snapshot: o CC-1 lê buyer_doc_number DO SNAPSHOT
      trigger_snapshot = ocj.trigger_snapshot || jsonb_build_object(
        'buyer_doc_number', NEW.buyer_doc_number,
        'buyer_doc_type',   NEW.buyer_doc_type,
        'buyer_name',       NEW.buyer_name,
        'buyer_email',      NEW.buyer_email,
        'buyer_phone',      NEW.buyer_phone,
        'shipping_status',  NEW.shipping_status
      ),
      updated_at       = now()
    WHERE ocj.order_id = NEW.id
      AND ocj.state    = 'blocked_no_contact';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'reactivate_ocj_on_cpf failed for order %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_orders_cpf_reactivate ON public.orders;
CREATE TRIGGER trg_orders_cpf_reactivate
  AFTER UPDATE OF buyer_doc_number ON public.orders
  FOR EACH ROW
  WHEN (OLD.buyer_doc_number IS NULL AND NEW.buyer_doc_number IS NOT NULL)
  EXECUTE FUNCTION public.reactivate_ocj_on_cpf();

-- ─── 4. Reativação quando o CONTATO chega no CLIENTE ───────────────────────
-- Cobre enriquecimento que acontece FORA do CC-1 (batch manual, outro fluxo):
-- cliente ganhou fone/email → OCJs recentes dele que morreram em
-- blocked_no_contact voltam pra fila. Só OCJ cujo snapshot JÁ tem CPF
-- (sem CPF o CC-1 não resolve o cliente e re-bloquearia à toa).
CREATE OR REPLACE FUNCTION public.reactivate_ocj_on_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    UPDATE order_communication_journeys ocj SET
      state          = 'pending',
      stopped_reason = NULL,
      last_error     = NULL,
      updated_at     = now()
    FROM orders o
    WHERE ocj.customer_id = NEW.id
      AND ocj.state       = 'blocked_no_contact'
      AND ocj.trigger_snapshot->>'buyer_doc_number' IS NOT NULL
      AND ocj.created_at  > now() - interval '7 days'
      AND o.id            = ocj.order_id
      AND COALESCE(o.status, '')          <> 'cancelled'
      AND COALESCE(o.shipping_status, '') <> 'cancelled';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'reactivate_ocj_on_contact failed for customer %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_uc_contact_reactivate ON public.unified_customers;
CREATE TRIGGER trg_uc_contact_reactivate
  AFTER UPDATE OF phone, email ON public.unified_customers
  FOR EACH ROW
  WHEN (
    OLD.phone IS NULL AND OLD.email IS NULL
    AND (NEW.phone IS NOT NULL OR NEW.email IS NOT NULL)
  )
  EXECUTE FUNCTION public.reactivate_ocj_on_contact();
