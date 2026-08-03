-- Sessão 2026-08-03 — Estoque mínimo passa a ser comparado contra o FÍSICO.
--
-- PROBLEMA
-- A regra de pausa comparava `min_stock_to_pause` contra (físico + virtual).
-- A regra de vitrine virtual gravava min = virtual (ex.: 10.000 e 10.000), o
-- que dava o efeito desejado — pausar quando o físico zera — mas por um
-- caminho torto: qualquer OUTRO valor de mínimo virava letra morta. Num
-- produto com virtual 10.000, digitar "pausar em 3" na tela de Estoque virava
-- a conta `10.003 <= 3` → nunca pausava. O campo aceitava, salvava e não
-- fazia nada.
--
-- CORREÇÃO (backend, mesmo commit)
-- `rulePause = (físico − reservado) <= min_stock_to_pause`.
--
-- MIGRAÇÃO DE DADOS
-- Com a comparação nova, um mínimo de 10.000 pausaria TODO o catálogo na hora
-- (físico 90 <= 10.000). O equivalente exato ao comportamento de hoje é 0
-- (pausa quando o físico zera). Esta migration reescreve só as linhas com a
-- assinatura da regra antiga (min = virtual e min > 0), preservando o
-- comportamento atual byte a byte. Quem já tinha um mínimo "de verdade"
-- (min != virtual) fica intacto — e passa a funcionar pela primeira vez.
--
-- A view v_stock_summary já usava a semântica nova
-- (quantity <= min_stock_to_pause), então ela só fica correta depois daqui.

-- ── 1. Regra de vitrine virtual: min = virtual  →  min = 0 ──────────────────
UPDATE public.product_stock
SET min_stock_to_pause = 0,
    updated_at         = now()
WHERE platform IS NULL
  AND auto_pause_enabled IS TRUE
  AND min_stock_to_pause > 0
  AND min_stock_to_pause = virtual_quantity;

-- ── 2. Sanidade: mínimo nulo vira 0 (a conta trata NULL como 0 de qualquer
--      jeito; deixar explícito evita leitura errada na tela). ───────────────
UPDATE public.product_stock
SET min_stock_to_pause = 0
WHERE platform IS NULL
  AND min_stock_to_pause IS NULL;

-- ── 3. Conferência (aparece no log do supabase db push) ─────────────────────
DO $$
DECLARE
  com_regra   int;
  min_zerado  int;
  pausariam   int;
BEGIN
  SELECT count(*) INTO com_regra
    FROM public.product_stock
   WHERE platform IS NULL AND auto_pause_enabled IS TRUE;

  SELECT count(*) INTO min_zerado
    FROM public.product_stock
   WHERE platform IS NULL AND auto_pause_enabled IS TRUE AND min_stock_to_pause = 0;

  SELECT count(*) INTO pausariam
    FROM public.product_stock
   WHERE platform IS NULL AND auto_pause_enabled IS TRUE
     AND GREATEST(0, quantity - COALESCE(reserved_quantity, 0)) <= min_stock_to_pause;

  RAISE NOTICE 'estoque-minimo: % com regra ativa, % com minimo 0, % pausariam agora',
    com_regra, min_zerado, pausariam;
END $$;
