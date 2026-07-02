-- Quem moveu a ordem por último: 'auto' (telemetria da impressora / auto-dispatch)
-- ou 'manual' (usuário no quadro). Alimenta o badge ⚡ do kanban.
ALTER TABLE public.production_order
  ADD COLUMN IF NOT EXISTS last_transition_source text;
