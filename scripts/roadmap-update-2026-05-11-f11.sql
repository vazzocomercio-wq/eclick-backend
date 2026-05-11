-- ========================================================================
-- Roadmap update 2026-05-11 (sessão F11)
--
-- Adiciona F11 ML Executive Dashboard IA (E1-E5 + Fase 2) como fase nova.
-- Atualiza F7 (Quality Center) + F2 (Pedidos) com refinamentos colaterais.
-- Idempotente: phases por num+org, items por (phase+label).
-- ========================================================================

DO $$
DECLARE
  org_id uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833'::uuid;
  f11_id uuid;
  f7_id  uuid;
  f2_id  uuid;
BEGIN
  -- ── Pega ids das fases existentes ──
  SELECT id INTO f2_id FROM roadmap_phases WHERE num='F2' AND organization_id=org_id LIMIT 1;
  SELECT id INTO f7_id FROM roadmap_phases WHERE num='F7' AND organization_id=org_id LIMIT 1;

  -- ── F11 ML Executive Dashboard IA (NOVA) ──
  SELECT id INTO f11_id FROM roadmap_phases WHERE num='F11' AND organization_id=org_id LIMIT 1;
  IF f11_id IS NULL THEN
    INSERT INTO roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
    VALUES (org_id, 'F11', 'ML Executive Dashboard IA',
            'Home executiva, reputação, logística, visitas, ads, oportunidades',
            'done', 100, 11)
    RETURNING id INTO f11_id;
  END IF;

  -- F11 items — E1 a E5 + Fase 2 (3 cards de oportunidade)
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT org_id, f11_id, x.label, x.status, 0
  FROM (VALUES
    -- E1 a E5 entregues
    ('E1 — Foundation + agregação (VIEW v_dashboard_aggregated_metrics, cron 15min, real-time via order:invalidate)', 'done'),
    ('E2 — Reputação Mercado Líder (snapshots, métricas claims/cancellations/late, risk thresholds, trend)',          'done'),
    ('E3 — Logística (delays via /shipments/{id}/delays + Flex elegibilidade + envios pra despachar hoje)',            'done'),
    ('E4 — Visitas + Conversão (sync diário /items_visits/time_window + cruzamento orders)',                           'done'),
    ('E5 — Ads Visibility (consumo de ml_ads_* existente — sem F12 OAuth: ACOS/ROAS/spend/revenue + winners/losers)',  'done'),
    -- Fase 2 — 3 cards de oportunidade
    ('Fase 2 — Schema ml_fulfillment_inventory (snapshot diário FULL)',                                                'done'),
    ('Fase 2 — Schema ml_item_visits_period (visits por item, 4 janelas configuráveis)',                               'done'),
    ('Fase 2 — Extensão ml_flex_status (is_active + coverage_pct + VIEW v_flex_opportunity)',                          'done'),
    ('Fase 2 — Backfill products.category_ml_id (93.9% cobertura Vazzo)',                                              'done'),
    ('Fase 2 — VIEW v_leaderboard_visits_low_conv v2 (benchmark hierárquico cat → seller)',                            'done'),
    ('Fase 2 — Scanner Nest ml-intelligence/visits-scanner (cron 03:30 BRT, retry matrix, multi-conta)',               'done'),
    ('Fase 2 — Card "Full Fulfillment" (penetração + stale items)',                                                    'done'),
    ('Fase 2 — Card "Flex Opportunity" (196 elegíveis sem adesão em Vazzo + CTA)',                                     'done'),
    ('Fase 2 — Card "Visit Low Conv" (leaderboard muita visita pouca venda + sparkline 7d)',                           'done'),
    -- Polish e fixes pós-deploy
    ('Tradução PT-BR (Claims → Reclamações, ready_to_ship → envios prontos, items → itens, etc.)',                     'done'),
    ('Nickname das contas (VAZZO_, V20251215105533) em vez de "Conta {seller_id}" cru',                                'done'),
    ('Layout /atendimento/perguntas: campo resposta 220px, sugestão IA visível, grid responsivo',                      'done')
  ) AS x(label, status)
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap_items i
    WHERE i.phase_id = f11_id AND i.label = x.label
  );

  -- ── F2 +1 item: layout perguntas (atendimento) ──
  IF f2_id IS NOT NULL THEN
    INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
    SELECT org_id, f2_id, x.label, x.status, 0
    FROM (VALUES
      ('Atendimento/perguntas: layout responsivo, sugestão IA sem maxHeight, textarea 220px',  'done')
    ) AS x(label, status)
    WHERE NOT EXISTS (
      SELECT 1 FROM roadmap_items i
      WHERE i.phase_id = f2_id AND i.label = x.label
    );
  END IF;

  -- ── Recalcula pct das fases afetadas ──
  UPDATE roadmap_phases p SET
    pct = (
      SELECT GREATEST(0, LEAST(100, ROUND(100.0 *
        COUNT(*) FILTER (WHERE i.status = 'done') /
        NULLIF(COUNT(*), 0)
      )::int))
      FROM roadmap_items i WHERE i.phase_id = p.id
    ),
    updated_at = now()
  WHERE p.organization_id = org_id
    AND p.id IN (f11_id, f2_id, f7_id);

  RAISE NOTICE 'Roadmap atualizado: F11=% (executive dashboard) F2=% (pedidos) F7=% (quality)',
    f11_id, f2_id, f7_id;
END $$;
