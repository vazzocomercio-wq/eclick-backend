-- Exibição de pagamento na vitrine + checkout.
--
-- Cada loja configura como o preço é mostrado (à vista em destaque,
-- parcelado em destaque, ou Pix em destaque) e quais condições oferece:
--   - Parcelamento: até X vezes, até Y sem juros
--   - Pix com desconto: % de abatimento no preço
--
-- O preço final no checkout é calculado server-side com base nessas
-- settings (não dá pra o frontend manipular). O dashboard de pagamentos
-- também aplica estes parâmetros como defaults pro gateway escolhido
-- (MP/Stripe — quando integrado, ler max_installments da API e propor
-- como sugestão).
--
-- Estrutura JSON:
-- {
--   "installments": {
--     "enabled":          true,
--     "max":              12,         -- até quantas vezes mostrar
--     "interestFreeUpTo": 6           -- até quantas sem juros (<= max)
--   },
--   "pix": {
--     "enabled":     true,
--     "discountPct": 5                -- % de desconto no Pix (0..30)
--   },
--   "display": {
--     "format":              "installment_first",  -- 'total_first' | 'installment_first' | 'pix_first'
--     "showInstallmentLabel":true,                 -- mostrar "12x de R$ X"
--     "showPixPrice":        true                  -- mostrar preço com desconto Pix abaixo
--   }
-- }

ALTER TABLE public.store_config
  ADD COLUMN IF NOT EXISTS payment_display_settings JSONB
  DEFAULT '{
    "installments": { "enabled": true, "max": 12, "interestFreeUpTo": 6 },
    "pix":          { "enabled": true, "discountPct": 5 },
    "display":      { "format": "installment_first", "showInstallmentLabel": true, "showPixPrice": true }
  }'::jsonb;

COMMENT ON COLUMN public.store_config.payment_display_settings IS
  'Settings de exibição de preço (parcelas, Pix discount, formato) + condições no checkout.';

-- Garante que todas as orgs existentes recebam o default se vinha NULL.
UPDATE public.store_config
   SET payment_display_settings = '{
     "installments": { "enabled": true, "max": 12, "interestFreeUpTo": 6 },
     "pix":          { "enabled": true, "discountPct": 5 },
     "display":      { "format": "installment_first", "showInstallmentLabel": true, "showPixPrice": true }
   }'::jsonb
 WHERE payment_display_settings IS NULL;
