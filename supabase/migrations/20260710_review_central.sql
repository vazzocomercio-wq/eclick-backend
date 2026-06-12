-- 20260710 — Central de Avaliações multi-plataforma: automação.
-- Positiva → IA responde sozinha (piloto automático, opt-in por org).
-- Negativa/palavra sensível → WhatsApp do operador + card num funil do Active.
-- ML entra como 2ª plataforma (ingestão; ML NÃO permite resposta pública).

-- ── colunas de automação na tabela agnóstica ────────────────────────────────
ALTER TABLE public.marketplace_reviews
  ADD COLUMN IF NOT EXISTS automation_status       text,         -- auto_replied|task_created|skipped_neutral|error|null=não processada
  ADD COLUMN IF NOT EXISTS automation_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sensitive_terms         text[],       -- palavras sensíveis encontradas
  ADD COLUMN IF NOT EXISTS active_deal_id          text;         -- card criado no Active (funil)

CREATE INDEX IF NOT EXISTS idx_mp_reviews_automation_pending
  ON public.marketplace_reviews (organization_id, review_create_at DESC)
  WHERE automation_processed_at IS NULL;

-- ── config por organização ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.review_central_config (
  organization_id        uuid PRIMARY KEY REFERENCES public.organizations(id),
  autopilot_enabled      boolean NOT NULL DEFAULT false,  -- liga o piloto automático
  auto_reply_min_rating  integer NOT NULL DEFAULT 5,      -- ≥N estrelas = positiva (auto-resposta)
  auto_reply_window_days integer NOT NULL DEFAULT 30,     -- só avaliações recentes
  max_auto_per_hour      integer NOT NULL DEFAULT 20,     -- trava anti-rajada
  sensitive_words        text[]  NOT NULL DEFAULT ARRAY[
    'procon','processo','justiça','justica','advogado','jurídico','juridico',
    'golpe','fraude','falsificado','falso','polícia','policia','denúncia','denuncia',
    'perigoso','incêndio','incendio','choque','machucou','feriu','acidente','reclame aqui'
  ],
  notification_phone     text,                            -- WhatsApp do operador (alerta de negativa)
  active_org_id          uuid,                            -- org do Active (null = mesma do SaaS)
  active_pipeline_id     text,                            -- cache do funil (ensure 1x)
  active_stage_id        text,                            -- etapa de entrada do card
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON TABLE public.review_central_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.review_central_config TO authenticated;

ALTER TABLE public.review_central_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS review_central_config_org_isolation ON public.review_central_config;
CREATE POLICY review_central_config_org_isolation ON public.review_central_config
  FOR ALL TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  ));

-- 12/06 (mesmo dia, incremento): operador escolhido em vez de número digitado.
-- O telefone do alerta resolve do cadastro do operador no Active (org_members)
-- NA HORA do envio — cadastrou o WhatsApp lá depois, passa a funcionar sozinho.
ALTER TABLE public.review_central_config
  ADD COLUMN IF NOT EXISTS notification_operator_id uuid;
