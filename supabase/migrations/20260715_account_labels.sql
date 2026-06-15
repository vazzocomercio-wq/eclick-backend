-- Nome de exibição customizado por conta/loja, por organização.
-- Fonte ÚNICA da identidade visível das contas em todo o sistema (seletor do
-- dashboard, tags de Reclamações/Perguntas, Canais de Venda, etc). Não é
-- sobrescrita pelo sync do marketplace (ao contrário do nickname cru do ML,
-- que pode vir como código auto-gerado tipo "V20251215105533").
--
-- account_key (texto) unifica as chaves de cada plataforma:
--   - mercadolivre  → seller_id
--   - shopee        → shop_id (= channel_account_id)
--   - tiktok_shop   → account_id (= channel_account_id)

CREATE TABLE IF NOT EXISTS public.account_labels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  platform        text NOT NULL,
  account_key     text NOT NULL,
  display_name    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform, account_key)
);

CREATE INDEX IF NOT EXISTS idx_account_labels_org
  ON public.account_labels (organization_id, platform);

-- RLS ligada sem policy = deny-all pra authenticated (o frontend acessa só via
-- backend com service_role, que faz BYPASSRLS). Tabelas criadas via
-- _admin_exec_sql não herdam os GRANTs default do Supabase, então concedemos
-- explicitamente pro service_role (senão "permission denied" mesmo no backend).
ALTER TABLE public.account_labels ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.account_labels TO service_role;
