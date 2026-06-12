-- 20260708 — Chat de marketplace (Shopee sellerchat é a 1ª plataforma).
-- Conversas + mensagens agnósticas de plataforma, espelhando o desenho do
-- ml_conversations/ml_messages mas com colunas platform/shop_id pra
-- multi-loja e futuros canais (TikTok chat etc).
--
-- ⚠️ A ingestão fica DORMANTE até o app e-Click ganhar a permissão de Chat
-- API no Shopee Open Platform (hoje: error_api_permission) + env
-- SHOPEE_CHAT_SYNC='on'.

CREATE TABLE IF NOT EXISTS public.mp_chat_conversations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id),
  platform                 text NOT NULL DEFAULT 'shopee',
  shop_id                  text,                    -- loja (multi-loja)
  external_conversation_id text NOT NULL,           -- conversation_id da plataforma
  buyer_user_id            text,                    -- to_id (id do comprador)
  buyer_username           text,
  buyer_avatar             text,
  last_order_sn            text,                    -- último pedido referenciado no chat
  unread_count             integer NOT NULL DEFAULT 0,
  last_message_at          timestamptz,
  last_message_preview     text,
  last_message_from        text,                    -- 'buyer' | 'seller'
  raw                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform, external_conversation_id)
);

CREATE TABLE IF NOT EXISTS public.mp_chat_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id),
  conversation_id     uuid NOT NULL REFERENCES public.mp_chat_conversations(id) ON DELETE CASCADE,
  external_message_id text NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('buyer','seller')),
  message_type        text,                         -- text|image|sticker|item|order|video|...
  content             text,                         -- texto extraído (quando houver)
  media_url           text,                         -- url de imagem/vídeo quando o tipo for mídia
  sent_at             timestamptz,
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, conversation_id, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_chat_conv_org_last
  ON public.mp_chat_conversations (organization_id, platform, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mp_chat_msg_conv_sent
  ON public.mp_chat_messages (conversation_id, sent_at);

-- GRANTs explícitos (tabela via _admin_exec_sql não herda default privileges)
GRANT ALL ON TABLE public.mp_chat_conversations TO service_role;
GRANT ALL ON TABLE public.mp_chat_messages      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mp_chat_conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mp_chat_messages      TO authenticated;

ALTER TABLE public.mp_chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mp_chat_messages      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mp_chat_conv_org_isolation ON public.mp_chat_conversations;
CREATE POLICY mp_chat_conv_org_isolation ON public.mp_chat_conversations
  FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS mp_chat_msg_org_isolation ON public.mp_chat_messages;
CREATE POLICY mp_chat_msg_org_isolation ON public.mp_chat_messages
  FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));
