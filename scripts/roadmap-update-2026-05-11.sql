-- ========================================================================
-- Roadmap audit & update 2026-05-11
--
-- Reflete tudo que entregamos nas últimas 2 semanas. Cria F9 (Dropship)
-- e F10 (ML Listing Center IA) como fases novas, adiciona items às fases
-- existentes (F1, F2, F7), e recalcula pct das afetadas.
--
-- Idempotente onde dá: phases por num+org, items por (phase+label).
-- ========================================================================

DO $$
DECLARE
  org_id uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833'::uuid;
  f9_id  uuid;
  f10_id uuid;
  f1_id  uuid;
  f2_id  uuid;
  f7_id  uuid;
BEGIN
  -- ── Pega ids das fases existentes ──
  SELECT id INTO f1_id FROM roadmap_phases WHERE num='F1' AND organization_id=org_id LIMIT 1;
  SELECT id INTO f2_id FROM roadmap_phases WHERE num='F2' AND organization_id=org_id LIMIT 1;
  SELECT id INTO f7_id FROM roadmap_phases WHERE num='F7' AND organization_id=org_id LIMIT 1;

  -- ── F9 Dropship & Compras Inteligente (NOVA) ──
  SELECT id INTO f9_id FROM roadmap_phases WHERE num='F9' AND organization_id=org_id LIMIT 1;
  IF f9_id IS NULL THEN
    INSERT INTO roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
    VALUES (org_id, 'F9', 'Dropship & Compras Inteligente',
            'Catálogo, OCs, portal parceiro, devoluções, disputas, score, divergências',
            'done', 95, 9)
    RETURNING id INTO f9_id;
  END IF;

  -- F9 items (sprints 1-12 + sub-features). ON CONFLICT skip via existência check
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT org_id, f9_id, x.label, x.status, 0
  FROM (VALUES
    ('Catálogo + cost history + sync logs (Sprint 2)',            'done'),
    ('Bulk import wizard de produtos do parceiro (Sprint 2)',     'done'),
    ('Identificação automática de pedidos do parceiro + cron (Sprint 3)', 'done'),
    ('OC dropship + cron 22h + endpoints (Sprint 4)',             'done'),
    ('Excel download da OC + cutoff visual (Sprint 5)',           'done'),
    ('Portal do parceiro + envio email/WhatsApp (Sprint 6)',      'done'),
    ('Contas a Pagar + auto-vínculo OC (Sprint 7)',               'done'),
    ('Devoluções + régua de crédito 4 cenários (Sprint 8+9)',     'done'),
    ('Sistema de Disputas (Sprint 10)',                           'done'),
    ('Score do parceiro v1 — 5 dimensões (Sprint 11)',            'done'),
    ('Divergências por regra + Copiloto IA (Sprint 12)',          'done'),
    ('Onboarding checklist + pre-flight check de envio',          'done'),
    ('PDF server-side da OC (pdfkit) + downloads admin+parceiro', 'done'),
    ('Webhooks ML/Shopee de devolução + Copilot KB completo',     'done'),
    ('WhatsApp gratuito via Baileys com fallback Z-API/Meta',     'done'),
    ('Identificar pedidos via vínculo de listing antes do SKU',   'done'),
    ('Endpoint listConnectedAccounts pra UI de Novo Vínculo',     'done'),
    ('Defaults sensatos pra lead_time/safety/moq + DROP NOT NULL','done')
  ) AS x(label, status)
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap_items i
    WHERE i.phase_id = f9_id AND i.label = x.label
  );

  -- ── F10 ML Listing Center IA (NOVA) ──
  SELECT id INTO f10_id FROM roadmap_phases WHERE num='F10' AND organization_id=org_id LIMIT 1;
  IF f10_id IS NULL THEN
    INSERT INTO roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
    VALUES (org_id, 'F10', 'ML Listing Center IA',
            'Pricing, fiscal, pausados, health score, bulk actions',
            'done', 100, 10)
    RETURNING id INTO f10_id;
  END IF;

  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT org_id, f10_id, x.label, x.status, 0
  FROM (VALUES
    ('L1 — Foundation + Agregação (Sprint 1)',                                'done'),
    ('L1 — Scanner status + endpoints inactive + item view (Sprint 2)',       'done'),
    ('L2 — Pricing intelligence (price_to_win) (Sprint 3)',                   'done'),
    ('L2 — Automação preço ML + catálogo (Sprint 4)',                         'done'),
    ('L3 — Scanner fiscal + fix de atributos (Sprint 5)',                     'done'),
    ('L3 — Classificação rica de pausados (Sprint 6)',                        'done'),
    ('L4 — Health Score consolidado por anúncio (Sprint 7)',                  'done'),
    ('L4 — Bulk actions + KB copilot (Sprint 8 FECHA F10)',                   'done'),
    ('Cron diário @daily + endpoints copilot (refinamentos pós-Sprint 8)',    'done')
  ) AS x(label, status)
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap_items i
    WHERE i.phase_id = f10_id AND i.label = x.label
  );

  -- ── F1 +1 item ──
  IF f1_id IS NOT NULL THEN
    INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
    SELECT org_id, f1_id, x.label, x.status, 0
    FROM (VALUES
      ('DialogProvider customizado (substitui confirm/prompt nativos)', 'done')
    ) AS x(label, status)
    WHERE NOT EXISTS (
      SELECT 1 FROM roadmap_items i
      WHERE i.phase_id = f1_id AND i.label = x.label
    );
  END IF;

  -- ── F2 +7 items ──
  IF f2_id IS NOT NULL THEN
    INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
    SELECT org_id, f2_id, x.label, x.status, 0
    FROM (VALUES
      ('Pedidos em tempo real via webhook orders_v2 (ingest <3s)',                  'done'),
      ('Cancelados separados no dashboard + tab Canceladas',                         'done'),
      ('Lucro estimado preciso — desconta tarifa real + frete vendedor',             'done'),
      ('Mapa "Vendas por Região" populado (receiver_address via /shipments)',        'done'),
      ('Cards Faturamento/Lucro com comparação time-clamped (apples-to-apples)',    'done'),
      ('Slot "Meta do período" nos cards principais (lê goals table)',               'done'),
      ('Pílula "Faltam R$ X pra igualar / Superando em R$ X" destacada',             'done'),
      ('Resumo financeiro lê DB direto (não live ML) com cobertura de custos',       'done'),
      ('Multi-conta: aggregator itera todas contas ML em ingestDateRange',           'done')
    ) AS x(label, status)
    WHERE NOT EXISTS (
      SELECT 1 FROM roadmap_items i
      WHERE i.phase_id = f2_id AND i.label = x.label
    );
  END IF;

  -- ── F7 +5 items ──
  IF f7_id IS NOT NULL THEN
    INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
    SELECT org_id, f7_id, x.label, x.status, 0
    FROM (VALUES
      ('Vincular vários anúncios a um produto em massa (multi-conta)',         'done'),
      ('Seletor multi-conta no header de /catalogo/anuncios/mercadolivre',     'done'),
      ('Breakdown completo do frete (comprador + reembolso ML + bruto)',       'done'),
      ('Aba Vínculos no editor de produto (gerencia product_listings)',        'done'),
      ('RowMenu auto-flip nos cards de produto (animação smooth)',             'done'),
      ('CopyButton reutilizável (SKU/MLB/título com Copy→Check 1.2s)',         'done'),
      ('Filtro por seller_id em /ml/listings e /ml/listings/counts',           'done')
    ) AS x(label, status)
    WHERE NOT EXISTS (
      SELECT 1 FROM roadmap_items i
      WHERE i.phase_id = f7_id AND i.label = x.label
    );
  END IF;

  -- ── Recalcula pct das fases afetadas ──
  -- pct = round(100 * done / total) por fase. Considera só done vs total.
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
    AND p.id IN (f1_id, f2_id, f7_id, f9_id, f10_id);

  RAISE NOTICE 'Roadmap atualizado: F9=% F10=% F1=% F2=% F7=%', f9_id, f10_id, f1_id, f2_id, f7_id;
END $$;
