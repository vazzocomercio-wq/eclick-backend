-- Sprint ROADMAP — seed das 8 fases + items pra org Vazzo
--
-- Idempotente:
-- - Phases: ON CONFLICT (organization_id, num) DO NOTHING
-- - Items: WHERE NOT EXISTS (mesmo phase_id + label)
--
-- Roda DEPOIS do schema (2026_04_29_roadmap.sql). Pode rodar múltiplas
-- vezes sem efeito colateral.

BEGIN;

-- ── 1. Phases ────────────────────────────────────────────────────────────
INSERT INTO roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
VALUES
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F1','Base & Auth',                   'Fundação técnica',                   'done',    95, 1),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F2','Analytics & Inteligência',      'Pricing, compras, monitoramento',    'wip',     60, 2),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F3','CRM Robusto',                   'Clientes, segmentos, pipeline',      'new',     40, 3),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F4','SAC — Atendimento ao Cliente',  'Inbox unificado, tickets, IA',       'new',      0, 4),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F5','Campanhas & Social',            'WhatsApp, email, jornadas, IG',      'new',     15, 5),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F6','AI Criativo — Anúncios/Listings','Geração de imagens, títulos, descs', 'new',      0, 6),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F7','Estoque, ERP & Ads',            'Bling, MLAds, ShopeeAds, ROAS',      'planned',  0, 7),
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F8','Loja Própria & Multichannel',   'Storefront, white-label',            'planned',  0, 8)
ON CONFLICT (organization_id, num) DO NOTHING;

-- ── 2. Items helper: insere se ainda não existir (label+phase) ───────────
-- Wrapper inline em DO block pra reusar a lookup de phase_id.

DO $$
DECLARE
  v_org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  p_id  uuid;
BEGIN
  ----------------------------------------------------------------------
  -- F1 — Base & Auth (95%, done) — 7 items
  ----------------------------------------------------------------------
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F1';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Auth Supabase',              'done', 0),
    ('OAuth ML',                   'done', 0),
    ('OAuth Shopee',               'done', 0),
    ('Dashboard',                  'done', 0),
    ('Multi-tenant',               'done', 0),
    ('Sales aggregator',           'done', 0),
    ('Stripe billing',             'next', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F2 — Analytics & Inteligência (60%, wip) — 9 items
  ----------------------------------------------------------------------
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F2';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Purchasing Intelligence',                'done', 0),
    ('KPI cards',                              'done', 0),
    ('Importation Kanban',                     'done', 0),
    ('Suppliers CRUD',                         'done', 0),
    ('Margens inline',                         'done', 0),
    ('Monitor preços competitor',              'wip',  1),
    ('AI pricing',                             'next', 0),
    ('Resumo financeiro MercadoTurbo',         'next', 0),
    ('Ad copier',                              'next', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F3 — CRM Robusto (40%, new) — 10 items
  ----------------------------------------------------------------------
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F3';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Listagem clientes + bulk actions',       'done', 0),
    ('Merge clientes',                         'done', 0),
    ('Enrichment',                             'done', 0),
    ('Segmentos dinâmicos',                    'done', 0),
    ('App CRM independente',                   'new',  1),
    ('Timeline 360 cliente',                   'new',  0),
    ('Pipeline vendas Kanban',                 'new',  0),
    ('Scoring clientes IA',                    'new',  0),
    ('Importação em massa',                    'new',  0),
    ('Relatórios avançados',                   'next', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F4 — SAC (0%, new) — 10 items
  ----------------------------------------------------------------------
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F4';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Inbox unificado WA + email + ML',        'new', 1),
    ('Tickets com SLA e prioridade',           'new', 0),
    ('Atribuição atendentes + filas',          'new', 0),
    ('Templates resposta rápida',              'new', 0),
    ('Histórico vinculado ao CRM',             'new', 0),
    ('IA sugerindo respostas',                 'new', 0),
    ('CSAT / NPS',                             'new', 0),
    ('Dashboard SAC',                          'new', 0),
    ('Escalação automática',                   'new', 0),
    ('Chatbot triagem IA',                     'new', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F5 — Campanhas & Social (15%, new) — 10 items
  ----------------------------------------------------------------------
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F5';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Journey Engine OCJ',                     'done', 0),
    ('WhatsApp Z-API',                         'done', 0),
    ('Email multi-tenant',                     'done', 0),
    ('Campanhas com produtos',                 'new',  0),
    ('Segmentação avançada',                   'new',  0),
    ('Agendamento de campanhas',               'new',  0),
    ('Instagram Direct',                       'new',  0),
    ('A/B test mensagens',                     'new',  0),
    ('Analytics campanhas',                    'new',  0),
    ('Email webhook (delivered/bounced)',      'next', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F6 — AI Criativo (0%, new) — 8 items
  ----------------------------------------------------------------------
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F6';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Upload foto produto',                    'new', 0),
    ('Briefing de estilo',                     'new', 0),
    ('Geração 10 imagens via Flux',            'new', 0),
    ('Seleção e download de imagens',          'new', 0),
    ('Títulos otimizados via IA',              'new', 0),
    ('Descrições via IA',                      'new', 0),
    ('Publicação em marketplaces',             'new', 0),
    ('Histórico de criativos',                 'new', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F7 — Estoque/ERP/Ads (0%, planned) — 8 items
  ----------------------------------------------------------------------
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F7';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Bling',                                  'planned', 0),
    ('Inventário multi-plataforma',            'planned', 0),
    ('Curva ABC',                              'planned', 0),
    ('Reposição via IA',                       'planned', 0),
    ('MLAds',                                  'planned', 0),
    ('ShopeeAds',                              'planned', 0),
    ('ROAS',                                   'planned', 0),
    ('AI bidding',                             'planned', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F8 — Loja Própria & Multichannel (0%, planned) — 3 items
  ----------------------------------------------------------------------
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F8';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Loja própria',                           'planned', 0),
    ('Multichannel',                           'planned', 0),
    ('White-label',                            'planned', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);
END $$;

COMMIT;
