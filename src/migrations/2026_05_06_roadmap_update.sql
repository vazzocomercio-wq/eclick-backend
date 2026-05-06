-- Sprint ROADMAP — atualização do estado das fases após sprint 2026-04-29 → 2026-05-06
--
-- Mapeia commits dos repos eclick-frontend + eclick-backend desde o seed inicial
-- (2026_04_29_roadmap_seed.sql) pra refletir o que entrou em prod ou virou WIP.
--
-- Idempotente:
-- - Updates só rodam se status atual != novo (evita NOOP no updated_at)
-- - Inserts via `WHERE NOT EXISTS` (mesmo padrão do seed)
-- - pct recalculado manualmente no fim (recalcPhasePct do service só roda via API)
--
-- Aplicar com:
--   node scripts/apply-migration.mjs src/migrations/2026_05_06_roadmap_update.sql
--
-- NOTA: BEGIN/COMMIT removidos porque o RPC _admin_exec_sql já roda em
-- transação implícita; o DO block é atômico por si só.

DO $$
DECLARE
  v_org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  p_id  uuid;
BEGIN
  ----------------------------------------------------------------------
  -- F1 — Base & Auth: adiciona itens cross-cutting de UX/plataforma
  ----------------------------------------------------------------------
  -- Commits relacionados:
  --   87df910 — feat(roadmap): página /dashboard/roadmap
  --   6b07b43 — feat(ui): dialog provider customizado (substitui confirm/alert nativos)
  --   6598cc3 — feat(ui): scrollbar global no SaaS
  --   1b18621 — feat(ui): carrossel animado de sugestões em 3 telas IA
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F1';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Roadmap CRUD interno',                   'done', 0),
    ('Dialog provider customizado',            'done', 0),
    ('Scrollbar global padronizada',           'done', 0),
    ('Carrossel de sugestões IA (UI shared)',  'done', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F2 — Analytics & Inteligência: marca itens de pricing/Ad/MercadoTurbo como done
  -- + adiciona Intelligence Hub (sprint IH completa) e melhorias de dashboard.
  ----------------------------------------------------------------------
  -- Commits:
  --   PRC-1..6 (pricing-intelligence backend) + 4a6c13d (frontend cross-link)
  --   IH-1..5 (intelligence-hub backend + frontend completo)
  --   267d864 (cross-intel +5 padrões), 1d49bec/dbbbbc8 (follow-ups)
  --   961065f (popula KPIs antes vazios), 5b3ba03 (Reputação termômetro)
  --   09f3d93 (glow Faturamento/Lucro)
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F2';

  UPDATE roadmap_items SET status = 'done', updated_at = NOW()
   WHERE phase_id = p_id AND label = 'AI pricing' AND status != 'done';
  UPDATE roadmap_items SET status = 'done', updated_at = NOW()
   WHERE phase_id = p_id AND label = 'Resumo financeiro MercadoTurbo' AND status != 'done';
  UPDATE roadmap_items SET status = 'done', updated_at = NOW()
   WHERE phase_id = p_id AND label = 'Ad copier' AND status != 'done';

  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Intelligence Hub (CRUD + alertas + follow-ups + cross-intel)', 'done', 0),
    ('Dashboard KPIs ampliado (Ads spend, ROAS, atrasados, mensagens)', 'done', 0),
    ('Reputação ML como termômetro visual',           'done', 0),
    ('Pricing — links cruzados /precos ↔ /pricing/analise', 'done', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F3 — CRM Robusto: customer-hub drawer fecha "Timeline 360 cliente"
  ----------------------------------------------------------------------
  -- Commits: e274d97 (drawer + export CSV), 63c638e (bulk actions reais),
  --          38cb4c0 (ConfirmModal/MergeModal polish)
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F3';

  UPDATE roadmap_items SET status = 'done', updated_at = NOW()
   WHERE phase_id = p_id AND label = 'Timeline 360 cliente' AND status != 'done';

  ----------------------------------------------------------------------
  -- F4 — SAC: ML Questions AI sprint cobre "IA sugerindo respostas"
  ----------------------------------------------------------------------
  -- Commits: 590xxx (Sprint ML Questions AI — chips + sugestão + KPIs),
  --          a316318 (cron + sugestão IA backend), b0dfbbb (hydration fix)
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F4';

  UPDATE roadmap_items SET status = 'done', updated_at = NOW()
   WHERE phase_id = p_id AND label = 'IA sugerindo respostas' AND status != 'done';

  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Chips de sugestão IA em perguntas ML',   'done', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F5 — Campanhas & Social: sprint F5-2 completa + WhatsApp Free (Baileys)
  ----------------------------------------------------------------------
  -- Commits: 33cfcc4 + b0ce5ba + 86093dc + e44f4f1 + c82b40e (campanhas);
  --          a6c12e4 + c7cf7db (WhatsApp-Free/Baileys);
  --          a5778f2 + 0f66a0d (WaRouter); 6a65e3a (Email setup UI)
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F5';

  UPDATE roadmap_items SET status = 'done', updated_at = NOW()
   WHERE phase_id = p_id AND label = 'Campanhas com produtos' AND status != 'done';

  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Wizard de campanha multi-step',          'done', 0),
    ('AI card generator (capas com IA)',       'done', 0),
    ('WhatsApp Free (Baileys worker)',         'done', 0),
    ('WaRouter — canal por propósito',         'done', 0),
    ('Email setup UI multi-tenant',            'done', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F6 — AI Criativo: sprint massiva, todos os 8 itens base done + 6 extras
  ----------------------------------------------------------------------
  -- Commits backend: 977425e (E1) → 107072f (E2) → b675a9f (E3a Kling)
  --                  → fce7025 (E3b Canva) → c4161d8 + 92fac4e (E3c ML publish)
  --                  → 0bcaf40 (E3c sync) → f4c7870 (cleanup) → b55fcdd (templates)
  -- Commits frontend: 0e9df06 (E1 wizard) → d475e9f (E2 grid) → 6ebd96d (E3a player)
  --                   → 9cbbc9a (E3b Canva) → 6b05c60 + 1783420 + 9dc7563 (E3c)
  --                   → 66855a9 (custo + bulk regen) → 5d5ca6f (menu)
  --                   → 13d7d26 (notif nativas) → 43c62c2 (templates UI)
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F6';

  UPDATE roadmap_items SET status = 'done', updated_at = NOW()
   WHERE phase_id = p_id AND status != 'done' AND label IN (
    'Upload foto produto',
    'Briefing de estilo',
    'Geração 10 imagens via Flux',
    'Seleção e download de imagens',
    'Títulos otimizados via IA',
    'Descrições via IA',
    'Publicação em marketplaces',
    'Histórico de criativos'
   );

  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Geração de vídeo via Kling',             'done', 0),
    ('Editar criativo no Canva',               'done', 0),
    ('Dashboard de custo IA',                  'done', 0),
    ('Bulk regenerate de rejeitados',          'done', 0),
    ('Templates de briefing reutilizáveis',    'done', 0),
    ('Notificações nativas de conclusão',      'done', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- F7 — Estoque/ERP/Ads: sprint ML Ads completa (ML-2..5) e ROAS no dashboard
  ----------------------------------------------------------------------
  -- Commits: bcb0fb7 (ML-2 audit), 4ff4b02 (ML-3 pause/resume), e5e51c9 (ML-4 KPIs),
  --          68e094e (ML-5 sugestões IA inline), 2e88c33 (multi-tenant),
  --          e0a83c5/54a26e9 (backend ML-3/4), f4cd8eb (Ads AI chip)
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F7';

  UPDATE roadmap_items SET status = 'done', updated_at = NOW()
   WHERE phase_id = p_id AND status != 'done' AND label IN ('MLAds', 'ROAS');

  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Ads AI Assistant — chat sobre campanhas', 'done', 0),
    ('ML Ads multi-tenant (org scope)',         'done', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);

  ----------------------------------------------------------------------
  -- Recalcula pct e status das fases afetadas (formula = recalcPhasePct do service)
  -- pct = round((done + 0.5*wip) / total * 100)
  ----------------------------------------------------------------------
  UPDATE roadmap_phases p
  SET pct = COALESCE((
    SELECT ROUND(
      (COUNT(*) FILTER (WHERE i.status = 'done') + COUNT(*) FILTER (WHERE i.status = 'wip') * 0.5)
      / NULLIF(COUNT(*), 0)::numeric * 100
    )::int
    FROM roadmap_items i
    WHERE i.phase_id = p.id AND i.organization_id = v_org
  ), 0),
  updated_at = NOW()
  WHERE p.organization_id = v_org AND p.num IN ('F1','F2','F3','F4','F5','F6','F7');

  -- Promove status das fases que passaram do limiar:
  --   pct ≥ 100 → done
  --   pct ≥ 30  → wip   (saiu do "new")
  --   pct ≥ 1   → wip   (qualquer atividade real saiu de "planned")
  UPDATE roadmap_phases SET status = 'done', updated_at = NOW()
   WHERE organization_id = v_org AND num = 'F6' AND pct >= 95 AND status != 'done';

  UPDATE roadmap_phases SET status = 'wip', updated_at = NOW()
   WHERE organization_id = v_org AND num IN ('F3','F5','F7') AND pct >= 30 AND status NOT IN ('wip','done');

END $$;
