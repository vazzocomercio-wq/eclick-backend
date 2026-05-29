-- F18 F2.4 — Link Studio: links rastreáveis de afiliado por canal.
--
-- sub_id = `{org_short}_{channel}_{ts36}` → atribuição por canal (F2.5).
-- short_hash → URL encurtada api.eclick.app.br/go/{hash} → 302 destino.
-- tracked_url (link oficial Shopee) setado quando Affiliate API conectar;
-- até lá usa target_url (URL pública do produto + sub_id).
--
-- ⚠️ Sem BEGIN/COMMIT — RPC _admin_exec_sql rejeita transaction commands.

CREATE TABLE IF NOT EXISTS shopee.affiliate_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id          bigint NOT NULL,

  sub_id           text NOT NULL,                  -- atribuição por canal
  channel          text NOT NULL
                   CHECK (channel IN ('whatsapp','instagram','tiktok','shopee_video','shopee_live','blog')),

  short_hash       text NOT NULL,                  -- /go/{hash}
  target_url       text NOT NULL,                  -- fallback (produto + sub_id)
  tracked_url      text,                           -- link oficial Shopee (Affiliate API)

  clicks           integer NOT NULL DEFAULT 0,
  last_click_at    timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now()
);

-- short_hash é globalmente único (é a chave do redirect público)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliate_links_hash
  ON shopee.affiliate_links (short_hash);

-- sub_id único por org (atribuição não-ambígua)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliate_links_org_subid
  ON shopee.affiliate_links (organization_id, sub_id);

CREATE INDEX IF NOT EXISTS idx_affiliate_links_org_item
  ON shopee.affiliate_links (organization_id, item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_links_org_channel
  ON shopee.affiliate_links (organization_id, channel, created_at DESC);

COMMENT ON TABLE shopee.affiliate_links IS
  'F18 F2.4 — Links rastreáveis de afiliado. short_hash → /go redirect; sub_id pra atribuição por canal (F2.5).';

-- ── RLS + grants ────────────────────────────────────────────────────
ALTER TABLE shopee.affiliate_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members affiliate_links" ON shopee.affiliate_links;
CREATE POLICY "org members affiliate_links"
  ON shopee.affiliate_links FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()));

-- service_role faz o redirect público (resolve por short_hash sem auth de user)
GRANT ALL    ON TABLE shopee.affiliate_links TO service_role;
GRANT SELECT ON TABLE shopee.affiliate_links TO authenticated;

-- ── Roadmap → F2.4 wip ──────────────────────────────────────────────
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
     WHERE phase_id = v_phase_id AND label LIKE 'F2.4 —%';
  END IF;
END $$;
