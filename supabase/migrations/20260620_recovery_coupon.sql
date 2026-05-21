-- Loja Própria — cupom de incentivo no recovery de carrinho (AB2).
--
-- Quando o lojista habilita coupon no recovery, o cron gera um cupom
-- ÚNICO (usage_limit=1, expira em N horas) por carrinho e injeta o
-- código na mensagem do WhatsApp. Aumenta a conversão de recuperação.
--
-- reminder_coupon_code guarda o código gerado pra não recriar + pro
-- lojista ver no dashboard.

ALTER TABLE public.whatsapp_carts
  ADD COLUMN IF NOT EXISTS reminder_coupon_code text;

COMMENT ON COLUMN public.whatsapp_carts.reminder_coupon_code IS
  'Código do cupom único gerado pro lembrete de recovery (AB2). NULL se recovery sem cupom.';

-- Atualiza o default de cart_recovery_settings pra incluir os campos de
-- cupom (lojas existentes ganham via merge no service).
ALTER TABLE public.store_config
  ALTER COLUMN cart_recovery_settings SET DEFAULT
  '{"enabled":false,"minutes_after":30,"ttl_hours":72,"message_template":"","coupon_enabled":false,"coupon_discount_pct":10,"coupon_expires_hours":48}'::jsonb;
