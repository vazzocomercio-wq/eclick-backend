-- F12 Fulfillment — Onda B: painel tempo real "McDonald's".
-- Habilita Supabase Realtime em fulfillment_orders pra o painel atualizar ao vivo
-- (mudança de status/prazo → o board refaz a busca). RLS continua valendo no realtime
-- (o navegador só recebe eventos das linhas da própria org).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'fulfillment_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fulfillment_orders;
  END IF;
END $$;
