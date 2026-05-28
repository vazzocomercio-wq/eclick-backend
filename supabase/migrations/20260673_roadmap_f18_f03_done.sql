-- F18 F0.3 entregue — marca item como done e avança progresso da phase.
--
-- F0.3 = Webhook receiver POST /webhooks/shopee:
--   • Controller público (@Public) com @HttpCode(200) — ack rápido obrigatório
--     (Shopee retry agressivo em não-2xx)
--   • Service valida assinatura via ShopeeAdapter.validateWebhookSignature
--     (HMAC-SHA256 hex de partner_key sobre `${url}|${body}`)
--   • Persiste em marketplace_webhook_events ANTES de processar
--     (audit + replay; survive handler crash)
--   • Resolve organization_id via shop_id em marketplace_connections (best-
--     effort; nulo se loja órfã)
--   • Dispatcher por push_code (1=test/3=order_status/4=item_promotion/5=auth_
--     expiry/6=item_violation/12=auth_revoked/15=NF-e_BR) — stubs nesta
--     sprint, F1.x preenche handlers reais
--   • Soft-mode default: sig inválida ainda persiste + 200; ENV
--     SHOPEE_WEBHOOK_ENFORCE_SIG=true rejeita após confirmação de 1-2 semanas
--   • Raw body capturado em main.ts via verify callback do express json
--     (escopo /webhooks/* apenas; Shopee assina body literal byte-exact)
--
-- Progresso F18: 3/37 done (F0.4 + F0.5 + F0.3) ≈ 8%.

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
     AND label LIKE 'F0.3 —%';

  UPDATE public.roadmap_phases
     SET pct = 8, updated_at = now()
   WHERE id = v_phase_id;
END $$;
