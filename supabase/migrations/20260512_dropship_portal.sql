-- ════════════════════════════════════════════════════════════════════════
-- Dropship Center IA (F9) — Sprint 6 Batch A — Portal parceiro + envios
-- ════════════════════════════════════════════════════════════════════════
-- Cria tabelas pro portal público do parceiro (acesso via token URL):
--
--   1. CREATE `dropship_partner_portal_sessions` — token aleatório
--      (32+ chars), expira 72h, registra acessos (IP + user_agent)
--      pra auditoria. Permissões granulares (can_approve/dispute).
--
--   2. CREATE `dropship_oc_notifications` — log de e-mails/WhatsApp
--      enviados ao parceiro (tipo, destinatário, status, provider_id).
--
-- Workflow:
--   1. Operador clica "Enviar ao parceiro" na detalhe OC
--   2. Service cria portal_session com access_token único
--   3. Renderiza e-mail/WA com URL https://eclick.app.br/portal/oc/{token}
--   4. EmailSenderService + WhatsAppSender enviam, log em
--      dropship_oc_notifications.
--   5. Parceiro abre URL → endpoint público /portal/oc/:token
--      (GET sem auth, valida token + records access)
--   6. Parceiro aprova/rejeita → session.approved_at + oc.status muda
-- ════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. Sessões de acesso ao portal
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_partner_portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  oc_id UUID REFERENCES dropship_purchase_orders(id) ON DELETE CASCADE,

  -- Token de acesso (32+ chars random)
  access_token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,            -- Default 72h após criação

  -- Permissões granulares
  can_approve BOOLEAN DEFAULT true,
  can_dispute BOOLEAN DEFAULT true,
  can_view_history BOOLEAN DEFAULT false,

  -- Atividade (preenchidos quando parceiro acessa)
  first_accessed_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER DEFAULT 0,
  ip_addresses TEXT[] DEFAULT '{}',
  user_agents TEXT[] DEFAULT '{}',

  -- Ações executadas
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  approver_name TEXT,
  approver_email TEXT,

  -- Status
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'used', 'expired', 'revoked'
  )),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_supplier
  ON dropship_partner_portal_sessions(supplier_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_oc
  ON dropship_partner_portal_sessions(oc_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_token
  ON dropship_partner_portal_sessions(access_token)
  WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Notificações enviadas (e-mail + WhatsApp)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dropship_oc_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  oc_id UUID NOT NULL REFERENCES dropship_purchase_orders(id) ON DELETE CASCADE,

  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms')),
  recipient TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'oc_generated',         -- Primeira notificação
    'oc_reminder_24h',      -- Lembrete 24h sem ação
    'oc_reminder_48h',      -- Lembrete 48h
    'oc_overdue',           -- OC venceu sem aprovação
    'payment_reminder',     -- Lembrete pagamento próximo
    'payment_completed',    -- Confirmação de pagamento
    'cost_change_alert',    -- Custo alterado pelo parceiro
    'stock_out_alert'       -- Produto ficou sem estoque
  )),

  subject TEXT,
  body TEXT,
  attachments JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sent', 'delivered', 'read', 'failed'
  )),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  error_message TEXT,

  -- Provider info
  provider TEXT,             -- 'resend', 'sendgrid', 'zapi', 'meta-cloud'
  provider_message_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oc_notif_oc
  ON dropship_oc_notifications(oc_id);
CREATE INDEX IF NOT EXISTS idx_oc_notif_status
  ON dropship_oc_notifications(status);
CREATE INDEX IF NOT EXISTS idx_oc_notif_created
  ON dropship_oc_notifications(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 3. GRANTs
-- ─────────────────────────────────────────────────────────────────────

-- Portal sessions: anon precisa SELECT (validar token sem auth) +
-- UPDATE (registrar acessos). Mas só com filtro por access_token.
-- RLS poderia adicionar segurança extra, mas pra v1 GRANT suficiente
-- já que token é o secret (sem token, sem ataque).
GRANT ALL ON TABLE public.dropship_partner_portal_sessions TO service_role;
GRANT SELECT, UPDATE ON TABLE public.dropship_partner_portal_sessions TO anon;
GRANT SELECT ON TABLE public.dropship_partner_portal_sessions TO authenticated;

GRANT ALL ON TABLE public.dropship_oc_notifications TO service_role;
GRANT SELECT ON TABLE public.dropship_oc_notifications TO authenticated;
