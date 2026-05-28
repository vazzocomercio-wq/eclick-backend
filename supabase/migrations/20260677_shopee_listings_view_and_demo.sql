-- F18 F1.2 (backend slice) — view de scores mais recentes + seed demo.
--
-- View `shopee.v_latest_algo_score` — DISTINCT ON (shop, item) ORDER BY
-- computed_at DESC. Listing Center frontend usa pra montar grid + sort
-- por score asc (priorizar correção dos piores).
--
-- Seed demo: 3 rows pra org "Shopee Review Demo" (criada pelo script
-- scripts/provision-shopee-reviewer.mjs em 2026-05-28). Espelha as
-- fixtures GOLD/MED/BAD do smoke test pra Shopee reviewers verem a UI
-- VIVA durante a App Review (mesmo sem loja real conectada). Limpeza
-- pós-approval: rodar provision-shopee-reviewer.mjs --teardown (drop
-- cascata da org → CASCADE remove os scores).
--
-- shop_id 999990001 = fake demo (não colide com real Shopee shop_ids
-- que tipicamente são ≥ 1e10).

-- ── 1. View de score mais recente por (shop, item) ──────────────────
CREATE OR REPLACE VIEW shopee.v_latest_algo_score AS
SELECT DISTINCT ON (organization_id, shop_id, item_id)
  id,
  organization_id,
  shop_id,
  item_id,
  product_id,
  algo_score,
  relevance,
  performance,
  seller_quality,
  price_marketing,
  issues,
  input_snapshot,
  computed_at
FROM shopee.algo_score_breakdown
ORDER BY organization_id, shop_id, item_id, computed_at DESC;

COMMENT ON VIEW shopee.v_latest_algo_score IS
  'F18 F1.2 — Score mais recente por (org, shop, item). Fonte: ' ||
  'algo_score_breakdown via DISTINCT ON. Listing Center consome esta view.';

GRANT SELECT ON shopee.v_latest_algo_score TO authenticated, service_role;

-- ── 2. Seed demo na org Shopee Review Demo ──────────────────────────
DO $$
DECLARE
  v_demo_org uuid;
BEGIN
  SELECT id INTO v_demo_org
  FROM public.organizations
  WHERE slug = 'shopee-review-demo';

  IF v_demo_org IS NULL THEN
    RAISE NOTICE 'org shopee-review-demo ausente — pulando seed';
    RETURN;
  END IF;

  -- Limpa seed antigo pra reaplicar idempotente
  DELETE FROM shopee.algo_score_breakdown
   WHERE organization_id = v_demo_org AND shop_id = 999990001;

  -- GOLD — anúncio ouro (score 96)
  INSERT INTO shopee.algo_score_breakdown (
    organization_id, shop_id, item_id,
    algo_score, relevance, performance, seller_quality, price_marketing,
    issues, input_snapshot
  ) VALUES (
    v_demo_org, 999990001, 1001,
    96, 94, 100, 100, 87,
    '[]'::jsonb,
    jsonb_build_object(
      'title', 'Arandela LED Cristal K9 Dourada 5W Quente Sala Quarto Decoração Premium',
      'main_image_url', 'https://placehold.co/600x600/0a0a0f/00e5ff?text=Arandela+K9+Dourada',
      'sales_7d', 14, 'ctr', 0.045, 'conversion', 0.08, 'price', 89.90
    )
  );

  -- MED — anúncio médio (score 55)
  INSERT INTO shopee.algo_score_breakdown (
    organization_id, shop_id, item_id,
    algo_score, relevance, performance, seller_quality, price_marketing,
    issues, input_snapshot
  ) VALUES (
    v_demo_org, 999990001, 1002,
    55, 47, 64, 68, 38,
    '[
      {
        "pillar":"relevance","code":"short_title","severity":"high",
        "description":"Título muito curto (22 chars). Shopee favorece títulos descritivos.",
        "recommended_action":"Expandir pra 60-100 chars com keyword principal + cor/tamanho/material.",
        "current_value":22,"target_value":80
      },
      {
        "pillar":"relevance","code":"incomplete_attrs","severity":"medium",
        "description":"Faltam 6 atributos obrigatórios.",
        "recommended_action":"Completar atributos restantes pra max relevância.",
        "current_value":6,"target_value":12
      },
      {
        "pillar":"price_marketing","code":"high_price","severity":"medium",
        "description":"Preço 5% acima do líder do mercado.",
        "recommended_action":"Reavaliar margem ou justificar com diferencial (frete grátis, bônus).",
        "current_value":"1.05","target_value":"≤1.05"
      },
      {
        "pillar":"price_marketing","code":"no_marketing","severity":"low",
        "description":"Sem voucher / flash sale / ads ativos.",
        "recommended_action":"Testar 1 voucher exclusivo (-5%) + boost de R$30 em ads."
      }
    ]'::jsonb,
    jsonb_build_object(
      'title', 'Arandela LED Dourada',
      'main_image_url', 'https://placehold.co/600x600/0a0a0f/8b8b8b?text=Arandela',
      'sales_7d', 3, 'ctr', 0.015, 'conversion', 0.025, 'price', 105.00
    )
  );

  -- BAD — anúncio ruim (score 13)
  INSERT INTO shopee.algo_score_breakdown (
    organization_id, shop_id, item_id,
    algo_score, relevance, performance, seller_quality, price_marketing,
    issues, input_snapshot
  ) VALUES (
    v_demo_org, 999990001, 1003,
    13, 22, 4, 8, 14,
    '[
      {
        "pillar":"seller_quality","code":"critical_penalty","severity":"high",
        "description":"7 pontos de punição — risco de suspensão.",
        "recommended_action":"EMERGÊNCIA: contatar Shopee + corrigir violações + recurso.",
        "current_value":7,"target_value":0
      },
      {
        "pillar":"performance","code":"no_sales","severity":"high",
        "description":"Anúncio sem vendas em 7d.",
        "recommended_action":"Investigar preço, qualidade da listagem e visibilidade (CTR)."
      },
      {
        "pillar":"performance","code":"very_low_ctr","severity":"high",
        "description":"CTR crítico (0.20%).",
        "recommended_action":"Revisar IMEDIATAMENTE: capa, título e preço comparado a top concorrente.",
        "current_value":"0.20%","target_value":">1%"
      },
      {
        "pillar":"seller_quality","code":"low_rating","severity":"high",
        "description":"Rating crítico 3.60.",
        "recommended_action":"Plano de recuperação: contato pessoal com clientes <3 estrelas + troca/reembolso.",
        "current_value":"3.60","target_value":"≥4.5"
      },
      {
        "pillar":"relevance","code":"missing_mandatory_attrs","severity":"high",
        "description":"Atributos obrigatórios incompletos (2/12).",
        "recommended_action":"Preencher TODOS os atributos obrigatórios da categoria — Shopee desranqueia.",
        "current_value":2,"target_value":12
      }
    ]'::jsonb,
    jsonb_build_object(
      'title', 'Arandela',
      'main_image_url', 'https://placehold.co/600x600/0a0a0f/444444?text=Arandela',
      'sales_7d', 0, 'ctr', 0.002, 'conversion', 0.003, 'price', 130.00
    )
  );
END $$;

-- ── 3. Roadmap: F1.2 ainda WIP (frontend pendente) ───────────────────
DO $$
DECLARE
  vazzo_org  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id FROM public.roadmap_phases
   WHERE organization_id = vazzo_org AND num = 'F18';

  -- Marca F1.2 como 'wip' (backend pronto; frontend próxima sprint).
  -- Não bumpa pct até frontend landar.
  UPDATE public.roadmap_items
     SET status = 'wip', updated_at = now()
   WHERE phase_id = v_phase_id
     AND label LIKE 'F1.2 —%';
END $$;
