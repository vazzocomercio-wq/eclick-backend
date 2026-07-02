-- Quando a ordem ENTROU na etapa atual (alimenta o aging "há 2d nesta etapa" do kanban).
-- Backfill aproximado: última atualização conhecida.
ALTER TABLE public.production_order
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
UPDATE public.production_order
  SET status_changed_at = COALESCE(updated_at, created_at)
  WHERE status_changed_at IS NULL;
