-- F18 F4.3 — Consent gate do afiliado (opt-in inbound, LGPD).
--
-- Afiliados são predominantemente PF. e-Click Prospect cravou: PF SÓ
-- opt-in/inbound, proibido raspar. Aqui o afiliado entra via self-signup
-- (/sou-afiliado-shopee) com consent EXPLÍCITO de aparecer no matchmaker.
--
-- Espelha o princípio do active.prospect_consent_ledger (opt-in auditável
-- + opt-out + legal_basis), mas LOCAL ao affiliate_profiles — sem acoplar
-- self-signup à estrutura de entidade Prospect (entity_id). Sync futuro
-- pode escrever no ledger se o afiliado virar entidade.
--
-- GATE: status='active' (= matcheável) EXIGE consent_at. Trigger bloqueia.
--
-- ⚠️ Sem BEGIN/COMMIT — RPC _admin_exec_sql rejeita transaction commands.

-- ── Campos de consent auditável ─────────────────────────────────────
ALTER TABLE shopee.affiliate_profiles
  ADD COLUMN IF NOT EXISTS consent_origin   text,                 -- 'inbound_signup' | 'admin' | 'import'
  ADD COLUMN IF NOT EXISTS consent_ip       text,                 -- IP do opt-in (LGPD prova)
  ADD COLUMN IF NOT EXISTS legal_basis      text DEFAULT 'consent',
  ADD COLUMN IF NOT EXISTS whatsapp_optin   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contact_email    text,
  ADD COLUMN IF NOT EXISTS contact_phone    text,
  ADD COLUMN IF NOT EXISTS opt_out_at       timestamptz,
  ADD COLUMN IF NOT EXISTS opt_out_reason   text;

COMMENT ON COLUMN shopee.affiliate_profiles.consent_origin IS
  'F4.3 — origem do opt-in (inbound_signup/admin/import). LGPD: prova de consentimento.';

-- ── GATE: active exige consent_at (trigger) ─────────────────────────
CREATE OR REPLACE FUNCTION shopee.tg_affiliate_consent_gate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Só pode ficar 'active' (matcheável no Matchmaker) com consent registrado.
  IF NEW.status = 'active' AND NEW.consent_at IS NULL THEN
    RAISE EXCEPTION 'Afiliado não pode ser ativado sem consent_at (LGPD opt-in obrigatório — F4.3)';
  END IF;
  -- Opt-out força status revoked (não-matcheável).
  IF NEW.opt_out_at IS NOT NULL AND NEW.status = 'active' THEN
    NEW.status := 'revoked';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_affiliate_consent_gate ON shopee.affiliate_profiles;
CREATE TRIGGER trg_affiliate_consent_gate
  BEFORE INSERT OR UPDATE ON shopee.affiliate_profiles
  FOR EACH ROW EXECUTE FUNCTION shopee.tg_affiliate_consent_gate();

-- INSERT pro self-signup público precisa de INSERT grant pra anon? Não —
-- o endpoint /register usa service_role no backend (sem auth de user).
-- authenticated mantém só SELECT (RLS já existente).

-- ── Roadmap → F4.3 wip ──────────────────────────────────────────────
DO $$
DECLARE
  vazzo_org  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  v_phase_id uuid;
BEGIN
  SELECT id INTO v_phase_id FROM public.roadmap_phases
   WHERE organization_id = vazzo_org AND num = 'F18';
  IF v_phase_id IS NOT NULL THEN
    UPDATE public.roadmap_items
       SET status = 'wip', updated_at = now()
     WHERE phase_id = v_phase_id AND label LIKE 'F4.3 —%';
  END IF;
END $$;
