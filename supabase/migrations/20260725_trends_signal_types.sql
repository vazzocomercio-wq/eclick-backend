-- Radar de Tendências — amplia os tipos de sinal capturados na série temporal.
-- Adiciona 'price' (histórico de preço de referência) e 'score' (Trend Score
-- no tempo) pra alimentar a tela de Análise por produto (gráficos).
ALTER TABLE public.trends_signals DROP CONSTRAINT IF EXISTS trends_signals_signal_type_check;
ALTER TABLE public.trends_signals ADD CONSTRAINT trends_signals_signal_type_check
  CHECK (signal_type IN ('search_trend', 'best_seller', 'visits', 'price', 'score'));
