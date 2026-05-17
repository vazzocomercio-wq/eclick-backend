-- ════════════════════════════════════════════════════════════════════════════
-- e-Click Radar IA — price_to_win (status real do catálogo)
-- ════════════════════════════════════════════════════════════════════════════
--
-- O R3 não conseguiu o ganhador real do catálogo (`buy_box_winner` vinha null)
-- e caiu numa heurística de "menor preço" (is_lowest_price). O endpoint
-- /items/{id}/price_to_win?version=v2 — confirmado por spike 2026-05-17 —
-- entrega o dado REAL: status do catálogo (winning/competing/...) + o preço
-- exato pra ganhar. Só responde para itens PRÓPRIOS (token da conta dona).
--
-- Colunas preenchidas pelo coletor de ofertas (eclick-workers) só na oferta
-- própria (is_own=true). Concorrente fica NULL — o ML não expõe.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.radar_offers
  ADD COLUMN IF NOT EXISTS price_to_win            numeric,
  ADD COLUMN IF NOT EXISTS catalog_status          text,
  ADD COLUMN IF NOT EXISTS catalog_winner_price    numeric,
  ADD COLUMN IF NOT EXISTS price_to_win_checked_at timestamptz;

COMMENT ON COLUMN public.radar_offers.price_to_win IS
  'Preço necessário para ganhar o catálogo ML (/items/{id}/price_to_win). Só para is_own=true.';
COMMENT ON COLUMN public.radar_offers.catalog_status IS
  'Status real no catálogo ML: winning | competing | sharing_first_place | listed. Só para is_own=true.';
