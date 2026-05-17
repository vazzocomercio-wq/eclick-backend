-- ════════════════════════════════════════════════════════════════════════════
-- e-Click Radar IA — R2 fix · is_winner → is_lowest_price
-- ════════════════════════════════════════════════════════════════════════════
--
-- A spec R1 conflava "ganhador do catálogo" com "menor preço". Sondagem (10
-- produtos: 5 catálogos da Vazzo + 5 best-sellers de categoria) confirmou que
-- o ganhador real do buy-box NÃO é exposto pela API pública do ML:
--   - /products/{id}.buy_box_winner → null em todos
--   - /products/{id}/items → sem campo de ganhador
-- O R2 cravava is_winner por menor-preço — sinal real e útil, mas NÃO é o
-- buy-box (o ML pondera reputação, frete, Full). Renomear pro nome honesto.
--
-- Barato agora: ~110 linhas, R3/R4 ainda não construídos, zero rework downstream.
-- radar_offer_snapshots é particionada — RENAME no parent propaga às partições.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.radar_offers          RENAME COLUMN is_winner TO is_lowest_price;
ALTER TABLE public.radar_offer_snapshots RENAME COLUMN is_winner TO is_lowest_price;

-- radar_events.event_type: mudanca_buybox → mudanca_menor_preco
ALTER TABLE public.radar_events DROP CONSTRAINT IF EXISTS radar_events_event_type_check;
ALTER TABLE public.radar_events ADD CONSTRAINT radar_events_event_type_check
  CHECK (event_type IN (
    'queda_preco', 'alta_preco', 'mudanca_menor_preco',
    'novo_concorrente', 'saiu_concorrente', 'mudanca_frete'));
