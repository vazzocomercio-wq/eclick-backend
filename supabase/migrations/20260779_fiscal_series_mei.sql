-- Faturador F2b-3 (fundação) — numeração fiscal + regime MEI.
--
-- 1) fiscal_series: controle SEQUENCIAL da numeração de NF-e por (empresa,
--    série, ambiente). Numeração fiscal é irreversível: pular número = ter de
--    INUTILIZAR a faixa na SEFAZ. Por isso a reserva é atômica (RPC abaixo),
--    nunca Date.now() nem MAX(n)+1 em duas queries.
-- 2) fiscal_next_number(): reserva 1 número num único statement (INSERT ON
--    CONFLICT UPDATE ... RETURNING) — sem corrida entre 2 emissões simultâneas.
-- 3) regime_tributario ganha 'mei' (CRT 4 na NF-e desde a NT 2023.001) —
--    caso da loja Shopee "Tudo em Casa Online" (MEI da Deisilene, BA).

-- ── 1) Série fiscal ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fiscal_series (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES public.fulfillment_companies(id) ON DELETE CASCADE,
  serie           integer NOT NULL DEFAULT 1 CHECK (serie BETWEEN 1 AND 999),
  ambiente        text NOT NULL CHECK (ambiente IN ('homologacao','producao')),
  -- PRÓXIMO número a emitir (o último emitido é next_number - 1)
  next_number     bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, company_id, serie, ambiente)
);
CREATE INDEX IF NOT EXISTS idx_fiscal_series_org ON public.fiscal_series(organization_id);

COMMENT ON TABLE public.fiscal_series IS
  'Numeração sequencial de NF-e por (empresa, série, ambiente). Reservar número SÓ via RPC fiscal_next_number.';

DROP TRIGGER IF EXISTS trg_fiscal_series_touch ON public.fiscal_series;
CREATE TRIGGER trg_fiscal_series_touch BEFORE UPDATE ON public.fiscal_series
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_touch();

-- ── 2) Reserva atômica de número ─────────────────────────────────────────────
-- Um único statement: linha nova nasce com next_number=2 e devolve 1; linha
-- existente incrementa e devolve o valor ANTES do incremento. O row lock do
-- UPDATE serializa emissões concorrentes da mesma série.
CREATE OR REPLACE FUNCTION public.fiscal_next_number(
  p_org uuid, p_company uuid, p_serie integer, p_ambiente text
) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO public.fiscal_series (organization_id, company_id, serie, ambiente, next_number)
  VALUES (p_org, p_company, p_serie, p_ambiente, 2)
  ON CONFLICT (organization_id, company_id, serie, ambiente)
  DO UPDATE SET next_number = fiscal_series.next_number + 1
  RETURNING next_number - 1;
$$;

REVOKE ALL ON FUNCTION public.fiscal_next_number(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fiscal_next_number(uuid, uuid, integer, text) TO service_role;

-- ── 3) Regime MEI ────────────────────────────────────────────────────────────
ALTER TABLE public.fiscal_company_config
  DROP CONSTRAINT IF EXISTS fiscal_company_config_regime_tributario_check;
ALTER TABLE public.fiscal_company_config
  ADD CONSTRAINT fiscal_company_config_regime_tributario_check
  CHECK (regime_tributario IN ('simples','presumido','real','mei'));

-- ── RLS + GRANTs (padrão da casa) ────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.fiscal_series ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS fiscal_series_org_read ON public.fiscal_series';
  -- membros da org só LEEM (a numeração anda exclusivamente pela RPC/service_role)
  EXECUTE 'CREATE POLICY fiscal_series_org_read ON public.fiscal_series FOR SELECT TO public USING (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'DROP POLICY IF EXISTS fiscal_series_srv ON public.fiscal_series';
  EXECUTE 'CREATE POLICY fiscal_series_srv ON public.fiscal_series FOR ALL TO service_role USING (true) WITH CHECK (true)';
  EXECUTE 'GRANT ALL ON TABLE public.fiscal_series TO service_role';
  EXECUTE 'GRANT SELECT ON TABLE public.fiscal_series TO authenticated';
END $$;
