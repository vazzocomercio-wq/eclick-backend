-- F18 F0.6 entregue — throttle por shop_id + retry com backoff exponencial.
--
-- Entregáveis:
--   • ShopThrottleService — Map<key, Promise> FIFO per-key (default 100ms =
--     ~10 req/s por shop_id). Calls de shops distintos rodam paralelo;
--     calls da MESMA shop serializam. Configurável via
--     SHOPEE_MIN_INTERVAL_MS pra tuning fino sem deploy.
--   • retryWithBackoff — wrapper que retry em 429/5xx/network errors
--     (NÃO em 4xx de input/auth), exponencial 1s→4s→16s cap 30s, jitter
--     ±20% pra evitar thundering herd, respeita header Retry-After se
--     servidor mandar. Max 3 tentativas total.
--   • ShopeeAdapter atualizado — listOrders/getOrderDetail/refreshToken
--     todos passam por callShopee(key, tag, exec) que combina throttle +
--     retry. Key é `shop:${shopId}` (refresh inclusive — não colide com
--     listOrders da mesma loja porque é mesma chave; serializa OK).
--
-- Single-instance OK (Railway 1 réplica). Cluster precisa Redis-lock —
-- mover quando virar gargalo (não é hoje).
--
-- Progresso F18: 4/37 done (F0.3 + F0.4 + F0.5 + F0.6) ≈ 11%.

DO $$
DECLARE
  vazzo_org  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id FROM public.roadmap_phases
   WHERE organization_id = vazzo_org AND num = 'F18';

  IF v_phase_id IS NULL THEN
    RAISE EXCEPTION 'Phase F18 não encontrada — aplicar 20260670 primeiro';
  END IF;

  UPDATE public.roadmap_items
     SET status = 'done', updated_at = now()
   WHERE phase_id = v_phase_id
     AND label LIKE 'F0.6 —%';

  UPDATE public.roadmap_phases
     SET pct = 11, updated_at = now()
   WHERE id = v_phase_id;
END $$;
