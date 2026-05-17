-- ════════════════════════════════════════════════════════════════════════════
-- e-Click Radar IA — R2 fix · partição de abril/2026 para radar_visit_snapshots
-- ════════════════════════════════════════════════════════════════════════════
--
-- O coletor de visitas puxa a janela dos últimos 30 dias
-- (/items/{id}/visits/time_window) — que SEMPRE alcança o mês anterior.
-- A migration R1 (20260573) criou partições a partir de 2026_05; faltava
-- 2026_04 → as linhas de visita com visit_date em abril falhavam no INSERT
-- ("no partition found"). O smoke do R2 pegou: 455 erros exatamente nessa faixa
-- (as 555 linhas de maio entraram normalmente).
--
-- radar_offer_snapshots NÃO precisa de partição retroativa: particiona por
-- collected_at (= momento da coleta = mês corrente).
--
-- Steady-state: a fn_create_next_radar_partitions() mantém os meses futuros;
-- o mês anterior sempre existe (foi o corrente no mês passado). O gap era só
-- o setup inicial.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.radar_visit_snapshots_2026_04
  PARTITION OF public.radar_visit_snapshots
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
