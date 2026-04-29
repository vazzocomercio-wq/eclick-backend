-- Sprint UI-1.1 fix-merge — soft delete + RPC atômica pra merge de clientes
--
-- Contexto: o merge atual (customer-identity.service.ts:mergeProfiles) faz
-- HARD DELETE da source row + migra apenas ai_conversations.unified_customer_id,
-- deixando 4 outras tabelas com customer_id apontando pra UUID inexistente
-- (order_communication_journeys, messaging_journey_runs, messaging_sends,
-- enrichment_log). Sem auditoria, sem org-scope, sem rollback.
--
-- Esta migration adiciona soft delete + audit trail + RPC transacional.
-- Após rodar, o backend deve passar a chamar `merge_customers(...)` em vez do
-- DELETE manual. Ver customer-identity.service.ts no commit que segue.
--
-- Rollback parcial (caso queira reverter as colunas — mas mantenha a RPC):
--   ALTER TABLE unified_customers
--     DROP COLUMN IF EXISTS merged_into,
--     DROP COLUMN IF EXISTS deleted_at,
--     DROP COLUMN IF EXISTS is_deleted;
--   DROP FUNCTION IF EXISTS merge_customers(uuid, uuid, uuid);

BEGIN;

-- ── PARTE 1 — Soft delete columns ────────────────────────────────────────
ALTER TABLE unified_customers
  ADD COLUMN IF NOT EXISTS is_deleted   boolean        NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS merged_into  uuid REFERENCES unified_customers(id) ON DELETE SET NULL;

-- Index partial pra acelerar listagens "ativas". Sem ele, todo `WHERE
-- is_deleted = false` em 8k+ linhas vira seq scan.
CREATE INDEX IF NOT EXISTS idx_unified_customers_active
  ON unified_customers (organization_id, updated_at DESC)
  WHERE is_deleted = false;

-- ── PARTE 2 — RPC atômica ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION merge_customers(
  p_org_id     uuid,
  p_keep_id    uuid,
  p_discard_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keep    unified_customers%ROWTYPE;
  v_discard unified_customers%ROWTYPE;
BEGIN
  IF p_keep_id = p_discard_id THEN
    RAISE EXCEPTION 'cannot merge customer with itself';
  END IF;

  -- Lock both rows pra impedir merge concorrente / race com edição.
  SELECT * INTO v_keep    FROM unified_customers WHERE id = p_keep_id    FOR UPDATE;
  SELECT * INTO v_discard FROM unified_customers WHERE id = p_discard_id FOR UPDATE;

  IF v_keep.id    IS NULL THEN RAISE EXCEPTION 'keep customer not found: %',    p_keep_id;    END IF;
  IF v_discard.id IS NULL THEN RAISE EXCEPTION 'discard customer not found: %', p_discard_id; END IF;

  -- Org scope: defesa em profundidade. O backend já valida via ReqUser.orgId,
  -- a RPC reforça caso alguém chame com service_role direto.
  IF v_keep.organization_id    <> p_org_id THEN RAISE EXCEPTION 'keep:    org mismatch';                END IF;
  IF v_discard.organization_id <> p_org_id THEN RAISE EXCEPTION 'discard: org mismatch';                END IF;
  IF v_discard.is_deleted                  THEN RAISE EXCEPTION 'discard already deleted';              END IF;
  IF v_keep.is_deleted                     THEN RAISE EXCEPTION 'cannot merge into a deleted customer'; END IF;

  -- ── Fill: keep recebe campos do discard onde keep está NULL/vazio. ──
  UPDATE unified_customers SET
    display_name        = COALESCE(NULLIF(display_name, ''),    v_discard.display_name),
    phone               = COALESCE(NULLIF(phone, ''),           v_discard.phone),
    email               = COALESCE(NULLIF(email, ''),           v_discard.email),
    whatsapp_id         = COALESCE(NULLIF(whatsapp_id, ''),     v_discard.whatsapp_id),
    ml_buyer_id         = COALESCE(NULLIF(ml_buyer_id, ''),     v_discard.ml_buyer_id),
    shopee_buyer_id     = COALESCE(NULLIF(shopee_buyer_id, ''), v_discard.shopee_buyer_id),
    avatar_url          = COALESCE(NULLIF(avatar_url, ''),      v_discard.avatar_url),
    tags                = ARRAY(
      SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || COALESCE(v_discard.tags, '{}'::text[]))
    ),
    notes               = NULLIF(
      CONCAT_WS(E'\n---\n', NULLIF(notes, ''), NULLIF(v_discard.notes, '')),
      ''
    ),
    total_conversations = COALESCE(total_conversations, 0) + COALESCE(v_discard.total_conversations, 0),
    total_purchases     = COALESCE(total_purchases,     0) + COALESCE(v_discard.total_purchases,     0),
    updated_at          = now()
  WHERE id = p_keep_id;

  -- ── Migra todas as 5 referências FK lógicas. ──
  -- ai_conversations já era migrada pelo TS antigo; as outras 4 NÃO eram.
  UPDATE ai_conversations              SET unified_customer_id = p_keep_id WHERE unified_customer_id = p_discard_id;
  UPDATE order_communication_journeys SET customer_id         = p_keep_id WHERE customer_id         = p_discard_id;
  UPDATE messaging_journey_runs       SET customer_id         = p_keep_id WHERE customer_id         = p_discard_id;
  UPDATE messaging_sends              SET customer_id         = p_keep_id WHERE customer_id         = p_discard_id;
  UPDATE enrichment_log               SET customer_id         = p_keep_id WHERE customer_id         = p_discard_id;

  -- ── Soft delete + audit trail no discard. ──
  UPDATE unified_customers SET
    is_deleted  = true,
    deleted_at  = now(),
    merged_into = p_keep_id,
    updated_at  = now()
  WHERE id = p_discard_id;
END;
$$;

-- Permite execução pelos roles que o backend usa.
-- service_role (NestJS supabaseAdmin) já tem acesso por padrão; authenticated
-- não chama essa RPC (vai sempre via API REST → backend → service_role), mas
-- liberar é defensivo se algum dia migrarmos pra RLS direta.
GRANT EXECUTE ON FUNCTION merge_customers(uuid, uuid, uuid) TO service_role;

COMMIT;
