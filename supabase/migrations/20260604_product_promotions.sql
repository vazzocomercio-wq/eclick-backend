-- Promoções por produto (Loja Própria).
--
-- Permite aplicar desconto direto no produto sem precisar de código de cupom.
-- O preço promocional aparece automaticamente na vitrine (badge "OFERTA" +
-- preço riscado) e no carrinho/checkout.
--
-- Campos:
--  - sale_price      : preço promocional FINAL (já com desconto). NULL = sem promoção.
--  - sale_start_at   : opcional. Se NULL, começa imediatamente.
--  - sale_end_at     : opcional. Se NULL, sem prazo (até admin remover).
--  - sale_badge_text : texto custom no badge ("OFERTA", "BLACK FRIDAY",
--                      "LIQUIDA"). Se NULL, usa "OFERTA" + % calculado.
--
-- Helper de leitura no backend: `getEffectivePrice(product, now)` retorna
-- sale_price se janela ativa, caso contrário retorna price normal.

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS sale_price       NUMERIC;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS sale_start_at    TIMESTAMPTZ;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS sale_end_at      TIMESTAMPTZ;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS sale_badge_text  TEXT;

-- Index pra rápido filtrar produtos em promoção por org.
CREATE INDEX IF NOT EXISTS products_org_sale_idx
  ON public.products (organization_id)
  WHERE sale_price IS NOT NULL;

-- Constraint: sale_price não pode ser maior que price (se setado).
-- Não bloqueia NULL — só valida quando há sale_price.
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_sale_price_below_price_chk;
ALTER TABLE public.products
  ADD CONSTRAINT products_sale_price_below_price_chk
  CHECK (sale_price IS NULL OR sale_price > 0);

COMMENT ON COLUMN public.products.sale_price IS
  'Preço promocional final (já com desconto). NULL = sem promoção.';
COMMENT ON COLUMN public.products.sale_start_at IS
  'Janela de início da promoção. NULL = vale imediatamente.';
COMMENT ON COLUMN public.products.sale_end_at IS
  'Janela de fim da promoção. NULL = sem prazo.';
COMMENT ON COLUMN public.products.sale_badge_text IS
  'Texto custom do badge ("OFERTA", "BLACK FRIDAY"). NULL = auto.';
