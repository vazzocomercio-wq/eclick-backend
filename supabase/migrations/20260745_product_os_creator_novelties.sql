-- ============================================================
-- Product OS — Alerta de novidades de criador
-- A watchlist de criadores vira ATIVA: um cron diário compara os modelos
-- recentes do criador com os já vistos e avisa o lojista por WhatsApp quando
-- ele lança algo novo. Guarda o conjunto de ids já vistos + último aviso.
-- Aditivo: 2 colunas.
-- ============================================================
ALTER TABLE public.mw_tracked_creator
  ADD COLUMN IF NOT EXISTS seen_external_ids TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_notified_at  TIMESTAMPTZ;
