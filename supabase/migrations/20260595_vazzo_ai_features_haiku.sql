-- Sessão 2026-05-20 — Override Vazzo: Sonnet → Haiku em 2 features pesadas.
--
-- Defaults (defaults.ts) usam claude-sonnet-4-6 pra `catalog_enrichment` e
-- `ml_question_suggest`. Esse uso pesou ~$80 em 30 dias (catalog: ~$67,
-- ml_question: ~$13) — e o catalog NEM tava persistindo o resultado (parser
-- bug). Pra Vazzo, troca pra Haiku 4.5 (~85% mais barato) via override
-- per-org em ai_feature_settings. Quando o saldo Anthropic voltar, cada
-- enriquecimento custa ~$0,005 em vez de ~$0,04.
--
-- Fallback mantido conforme defaults.ts:
--   catalog_enrichment  → null (sem fallback)
--   ml_question_suggest → openai/gpt-5-mini (resiliência)

INSERT INTO public.ai_feature_settings
  (organization_id, feature_key, primary_provider, primary_model,
   fallback_provider, fallback_model, enabled, updated_at)
VALUES
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'catalog_enrichment',
   'anthropic', 'claude-haiku-4-5-20251001', NULL, NULL, true, now()),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833', 'ml_question_suggest',
   'anthropic', 'claude-haiku-4-5-20251001', 'openai', 'gpt-5-mini', true, now())
ON CONFLICT (organization_id, feature_key) DO UPDATE SET
  primary_provider  = EXCLUDED.primary_provider,
  primary_model     = EXCLUDED.primary_model,
  fallback_provider = EXCLUDED.fallback_provider,
  fallback_model    = EXCLUDED.fallback_model,
  enabled           = EXCLUDED.enabled,
  updated_at        = now();
