-- Sessão 2026-06-11 — Integridade do ledger de estoque (auditoria Icarus).
--
-- Contexto: auditoria dos SKUs 20406080C / CD251199/200 (zerados no Icarus,
-- vivos nas plataformas) revelou 3 falhas no caminho venda→ledger:
--   1. applySaleMovement fazia read-check-then-insert SEM trava no banco →
--      webhook × cron de reconciliação em corrida gravaram 916 vendas e 36
--      estornos DUPLICADOS (35% do volume!), com lost-updates aleatórios.
--   2. Cancelamento re-creditava o físico incondicionalmente — em produto
--      dropship a verdade é o partner_stock do fornecedor; o estorno criava
--      estoque fantasma e "ressuscitava" anúncio de produto zerado no Icarus.
--   3. Nada re-assertava o saldo quando o Icarus ficava parado (sync é
--      incremental por movimento) — o drift virava permanente.
--
-- Este arquivo resolve 1 e 2 (o 3 é código: reconcile no IcarusSyncCron):
--   A. dedupe dos movimentos ml_order duplicados (mantém o mais antigo);
--   B. índice ÚNICO parcial — o banco passa a rejeitar o duplicado;
--   C. RPC apply_sale_movement_tx: venda/estorno transacional com
--      SELECT ... FOR UPDATE (serializa concorrência) + teto do estorno no
--      partner_stock pra produto dropship ativo.

-- ── A. Dedupe (mantém a linha mais antiga de cada chave) ─────────────────────
DELETE FROM public.stock_movements sm
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY reference_type, reference_id, movement_type
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM public.stock_movements
  WHERE reference_id IS NOT NULL
    AND reference_type IN ('ml_order', 'fulfillment_return')
) dup
WHERE sm.id = dup.id
  AND dup.rn > 1;

-- ── B. Trava única (parcial: só onde a chave é semanticamente única) ────────
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_movements_order_ref
  ON public.stock_movements (reference_type, reference_id, movement_type)
  WHERE reference_id IS NOT NULL
    AND reference_type IN ('ml_order', 'fulfillment_return');

-- ── C. RPC transacional de venda/estorno ────────────────────────────────────
-- Retorna: 'decremented' | 'reversed' | 'noop' | 'noop_no_stock'.
-- Regras:
--   • FOR UPDATE na linha-mestre → chamadas concorrentes serializam;
--   • idempotência checada DENTRO da transação (sem janela de corrida);
--   • estorno em produto com fornecedor dropship ativo respeita o teto
--     partner_stock: nunca SOBE acima do que o fornecedor declara (mas também
--     nunca DESCE o saldo atual — estorno não reduz).
CREATE OR REPLACE FUNCTION public.apply_sale_movement_tx(
  p_product_id        uuid,
  p_quantity          integer,
  p_external_order_id text,
  p_is_sale           boolean,
  p_channel           text DEFAULT 'mercadolivre'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ref_id       text := p_external_order_id || ':' || p_product_id::text;
  v_stock_id     uuid;
  v_qty          integer;
  v_has_sale     boolean;
  v_has_reversal boolean;
  v_cap          numeric;  -- teto dropship (NULL = produto sem fornecedor ativo)
  v_new          integer;
  v_note         text;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_product_id IS NULL THEN
    RETURN 'noop';
  END IF;

  -- Trava a linha-mestre: serializa webhook × cron pro mesmo produto.
  SELECT id, COALESCE(quantity, 0) INTO v_stock_id, v_qty
  FROM public.product_stock
  WHERE product_id = p_product_id AND platform IS NULL
  FOR UPDATE;

  IF v_stock_id IS NULL THEN
    RETURN 'noop_no_stock';
  END IF;

  SELECT
    bool_or(movement_type = 'sale'),
    bool_or(movement_type = 'sale_reversal')
  INTO v_has_sale, v_has_reversal
  FROM public.stock_movements
  WHERE reference_type = 'ml_order' AND reference_id = v_ref_id;

  v_has_sale     := COALESCE(v_has_sale, false);
  v_has_reversal := COALESCE(v_has_reversal, false);

  IF p_is_sale THEN
    IF v_has_sale THEN
      RETURN 'noop';  -- já baixado
    END IF;
    v_new := GREATEST(0, v_qty - p_quantity);
    v_note := 'Venda ' || COALESCE(p_channel, 'mercadolivre')
              || ' — pedido ' || p_external_order_id;

    UPDATE public.product_stock
    SET quantity = v_new, last_movement_at = now(), updated_at = now()
    WHERE id = v_stock_id;

    INSERT INTO public.stock_movements
      (product_id, stock_id, movement_type, quantity, balance_after,
       reference_type, reference_id, notes)
    VALUES
      (p_product_id, v_stock_id, 'sale', p_quantity, v_new,
       'ml_order', v_ref_id, v_note)
    ON CONFLICT DO NOTHING;

    RETURN 'decremented';
  END IF;

  -- Cancelamento — só estorna se houve baixa e ainda não estornou.
  IF NOT v_has_sale OR v_has_reversal THEN
    RETURN 'noop';
  END IF;

  -- Teto dropship: maior partner_stock entre os vínculos ativos do produto.
  SELECT MAX(GREATEST(COALESCE(partner_stock, 0), 0)) INTO v_cap
  FROM public.supplier_products
  WHERE product_id = p_product_id AND is_active = true;

  v_new := v_qty + p_quantity;
  v_note := 'Cancelamento — pedido ' || p_external_order_id;
  IF v_cap IS NOT NULL AND v_new > GREATEST(v_cap::integer, v_qty) THEN
    -- nunca sobe acima do que o fornecedor declara (nem desce o atual)
    v_new := GREATEST(v_cap::integer, v_qty);
    v_note := v_note || ' (estorno limitado ao estoque do fornecedor: '
              || v_cap::integer || ')';
  END IF;

  UPDATE public.product_stock
  SET quantity = v_new, last_movement_at = now(), updated_at = now()
  WHERE id = v_stock_id;

  INSERT INTO public.stock_movements
    (product_id, stock_id, movement_type, quantity, balance_after,
     reference_type, reference_id, notes)
  VALUES
    (p_product_id, v_stock_id, 'sale_reversal', p_quantity, v_new,
     'ml_order', v_ref_id, v_note)
  ON CONFLICT DO NOTHING;

  RETURN 'reversed';
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_sale_movement_tx(uuid, integer, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_sale_movement_tx(uuid, integer, text, boolean, text) TO service_role;
