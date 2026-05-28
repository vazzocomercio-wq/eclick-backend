-- F18 F0.4 — Log de webhooks entrantes de marketplaces (Shopee/ML/Magalu).
--
-- Idempotência: armazena o body cru + signature antes de processar. Se push
-- for reentregue, o handler detecta por (platform, push_id) e ignora.
-- Útil pra debug nas primeiras semanas de Shopee em prod (sandbox BR não
-- existe → log verboso é o único modo de auditar). Mantém 30 dias.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.marketplace_webhook_events;

BEGIN;

CREATE TABLE IF NOT EXISTS public.marketplace_webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Origem
  platform          text NOT NULL
                    CHECK (platform IN ('mercadolivre','shopee','amazon','magalu')),

  -- Identificadores opcionais (preenchidos pelo dispatcher após parse)
  shop_id           text,                              -- Shopee shop_id (uint64 → text)
  seller_id         text,                              -- ML seller_id
  organization_id   uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  push_id           text,                              -- ID do evento na plataforma (Shopee push_id, ML resource_id)
  push_code         integer,                           -- Shopee code 1..15 (15=NF-e BR)
  topic             text,                              -- ML topic (orders_v2, items, etc)

  -- Payload + assinatura
  url               text,                              -- url completa da request (Shopee assina url|body)
  raw_body          text NOT NULL,                     -- body CRU (não-JSON.parsed) — pra re-validar hash
  signature_header  text,                              -- Authorization (Shopee) ou X-Signature (ML)
  signature_valid   boolean NOT NULL DEFAULT false,
  signature_error   text,                              -- motivo se inválida (debug primeiras semanas)

  -- Lifecycle
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  processor_error   text,                              -- exception capturada se handler falhar
  retry_count       integer NOT NULL DEFAULT 0,

  -- Audit
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Idempotência: dedup por (platform, push_id) quando platform fornece um ID.
-- WHERE permite múltiplas linhas com push_id NULL (Shopee não envia em todos
-- os codes — fallback usa hash do body).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketplace_webhook_events_push
  ON public.marketplace_webhook_events (platform, push_id)
  WHERE push_id IS NOT NULL;

-- Queries operacionais frequentes
CREATE INDEX IF NOT EXISTS idx_marketplace_webhook_events_platform_time
  ON public.marketplace_webhook_events (platform, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_webhook_events_unprocessed
  ON public.marketplace_webhook_events (received_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_webhook_events_invalid_sig
  ON public.marketplace_webhook_events (platform, received_at DESC)
  WHERE signature_valid = false;

CREATE INDEX IF NOT EXISTS idx_marketplace_webhook_events_org
  ON public.marketplace_webhook_events (organization_id, received_at DESC)
  WHERE organization_id IS NOT NULL;

COMMENT ON TABLE public.marketplace_webhook_events IS
  'Log de webhooks entrantes de marketplaces (Shopee/ML/Magalu). Persistido ANTES do processamento pra debug e replay. Mantém 30d (cleanup via cron).';

COMMENT ON COLUMN public.marketplace_webhook_events.signature_valid IS
  'Resultado de adapter.validateWebhookSignature. false NÃO bloqueia ingestão — só sinaliza pra alertar humano.';

COMMENT ON COLUMN public.marketplace_webhook_events.url IS
  'URL completa do receptor (registrada no Partner Center). Shopee inclui no HMAC base; armazenar pra re-validação.';

-- ── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.marketplace_webhook_events ENABLE ROW LEVEL SECURITY;

-- Org members podem ler eventos da própria org (org_id pode ser null até o
-- dispatcher identificar — esses ficam só pro service_role).
DROP POLICY IF EXISTS "org members read webhook events" ON public.marketplace_webhook_events;
CREATE POLICY "org members read webhook events"
  ON public.marketplace_webhook_events FOR SELECT
  USING (
    organization_id IS NOT NULL
    AND organization_id IN (
      SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
    )
  );

-- service_role bypassa RLS por padrão (BYPASSRLS). GRANT explícito.
GRANT ALL    ON TABLE public.marketplace_webhook_events TO service_role;
GRANT SELECT ON TABLE public.marketplace_webhook_events TO authenticated;

-- ── Trigger updated_at ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_marketplace_webhook_events_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketplace_webhook_events_touch
  ON public.marketplace_webhook_events;
CREATE TRIGGER trg_marketplace_webhook_events_touch
  BEFORE UPDATE ON public.marketplace_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_marketplace_webhook_events_touch();

-- ── F18 — atualiza progresso (F0.4 + F0.5 entregues) ────────────────────
DO $$
DECLARE
  vazzo_org  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id FROM public.roadmap_phases
   WHERE organization_id = vazzo_org AND num = 'F18';

  IF v_phase_id IS NOT NULL THEN
    UPDATE public.roadmap_items
       SET status = 'done', updated_at = now()
     WHERE phase_id = v_phase_id
       AND (label LIKE 'F0.4 —%' OR label LIKE 'F0.5 —%');

    -- Atualiza progresso da fase: 2/37 items concluídos ≈ 5%
    UPDATE public.roadmap_phases
       SET status     = 'wip',
           pct        = 5,
           updated_at = now()
     WHERE id = v_phase_id;
  END IF;
END $$;

COMMIT;
