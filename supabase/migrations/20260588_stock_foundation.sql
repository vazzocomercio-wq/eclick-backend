-- Sessão 2026-05-19 (e-Click Saas 23) — Fundação do estoque unificado (Fase 0).
--
-- 1. Backfill: cria o registro-mestre em product_stock (platform/account_id NULL)
--    pra todo produto que ainda não tem. quantity = products.stock atual.
--    safety_mode='fixed' / safety_quantity=0 — sem redução de segurança por
--    padrão (o cálculo assume 10% quando safety_mode é nulo; aqui travamos 0).
-- 2. Gatilho: todo produto novo ganha o registro-mestre automaticamente —
--    cobre catálogo, Icarus, importação e qualquer caminho futuro.

-- ── 1. Backfill dos produtos sem registro ───────────────────────────────────
INSERT INTO public.product_stock
  (product_id, platform, account_id, quantity, virtual_quantity,
   reserved_quantity, safety_mode, safety_quantity, safety_percentage, auto_pause_enabled)
SELECT
  p.id, NULL, NULL, GREATEST(0, COALESCE(p.stock, 0)), 0,
  0, 'fixed', 0, 0, false
FROM public.products p
WHERE NOT EXISTS (
  SELECT 1 FROM public.product_stock ps
  WHERE ps.product_id = p.id AND ps.platform IS NULL AND ps.account_id IS NULL
);

-- ── 2. Gatilho de criação automática do registro-mestre ─────────────────────
CREATE OR REPLACE FUNCTION public.create_master_product_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  INSERT INTO public.product_stock
    (product_id, platform, account_id, quantity, virtual_quantity,
     reserved_quantity, safety_mode, safety_quantity, safety_percentage, auto_pause_enabled)
  VALUES
    (NEW.id, NULL, NULL, GREATEST(0, COALESCE(NEW.stock, 0)), 0,
     0, 'fixed', 0, 0, false);
  RETURN NEW;
EXCEPTION WHEN unique_violation THEN
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_create_master_product_stock ON public.products;
CREATE TRIGGER trg_create_master_product_stock
  AFTER INSERT ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.create_master_product_stock();
