-- F18 F3.1 — Threshold de margem mínima de campanha por org.
--
-- Gate: CampaignMarginService bloqueia campanha cuja margem líquida
-- (preço-desconto − comissão Shopee − comissão afiliado − custo − imposto)
-- fique abaixo deste %. Default 8% (conservador pra iluminação/decoração).
--
-- ⚠️ Sem BEGIN/COMMIT — RPC _admin_exec_sql rejeita transaction commands.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS min_campaign_margin_pct numeric(5,2) NOT NULL DEFAULT 8;

COMMENT ON COLUMN public.organizations.min_campaign_margin_pct IS
  'F18 F3.1 — Margem líquida mínima (%) pra liberar campanha Shopee. Gate em CampaignMarginService. Default 8%.';

-- ── Roadmap → F3.1 wip (frontend calculadora vem em seguida) ────────
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
     WHERE phase_id = v_phase_id AND label LIKE 'F3.1 —%';
  END IF;
END $$;
