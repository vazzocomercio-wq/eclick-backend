-- ═══════════════════════════════════════════════════════════════════════════
-- Custos de Produção 3D (prod3d) — custeio por absorção R$/g
-- Porta o motor validado em vazzo-produtos-3d (Python) pro e-Click.
-- Modelo: custos variáveis (filamento c/ purga, energia por MATERIAL,
-- depreciação, manutenção) por peça; falha divide por (1-taxa); custos fixos
-- mensais rateados nas gramas boas do mês. NÃO inclui custo de venda.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Parâmetros (1 row por org) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prod3d_config (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  tarifa_kwh               numeric NOT NULL DEFAULT 0.95,   -- R$/kWh final c/ impostos
  tarifa_kwh_estimado      boolean NOT NULL DEFAULT true,
  taxa_falha               numeric NOT NULL DEFAULT 0.05 CHECK (taxa_falha >= 0 AND taxa_falha < 1),
  fator_purga_ams          numeric NOT NULL DEFAULT 0.05 CHECK (fator_purga_ams >= 0 AND fator_purga_ams < 1),
  perdas_estimado          boolean NOT NULL DEFAULT true,
  manutencao_hora          numeric NOT NULL DEFAULT 0.15,   -- R$/h (bicos, mesa, correias)
  manutencao_estimado      boolean NOT NULL DEFAULT true,
  mo_custo_hora            numeric NOT NULL DEFAULT 0,      -- 0 se funcionário está nos fixos (anti contagem dupla)
  mo_minutos_padrao        numeric NOT NULL DEFAULT 10,
  horas_mes_por_impressora numeric NOT NULL DEFAULT 320,
  g_por_hora_fallback      numeric NOT NULL DEFAULT 15,     -- usado só sem SKUs cadastrados
  producao_estimado        boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ── Impressoras ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prod3d_impressoras (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  modelo           text NOT NULL,
  quantidade       int  NOT NULL DEFAULT 1 CHECK (quantidade > 0),
  valor_pago       numeric NOT NULL DEFAULT 0,
  vida_util_horas  int NOT NULL DEFAULT 6000 CHECK (vida_util_horas > 0),
  potencia_ams_w   numeric NOT NULL DEFAULT 0,
  estimado         boolean NOT NULL DEFAULT true,           -- valor_pago/vida_util não confirmados
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, modelo)
);
CREATE INDEX IF NOT EXISTS idx_prod3d_impressoras_org ON public.prod3d_impressoras(organization_id, is_active);

-- ── Potência média (W) por FAMÍLIA de material, por impressora ─────────────
-- Variantes resolvem por prefixo no service (PLA-SILK → PLA, PETG-HF → PETG).
CREATE TABLE IF NOT EXISTS public.prod3d_potencias (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  impressora_id    uuid NOT NULL REFERENCES public.prod3d_impressoras(id) ON DELETE CASCADE,
  material         text NOT NULL,                            -- família: PLA, PETG, TPU, ABS, ASA, PC, PA, PVA
  watts            numeric NOT NULL CHECK (watts > 0),
  estimado         boolean NOT NULL DEFAULT true,
  fonte            text,                                     -- de onde veio o número (wiki oficial, tomada medidora…)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, impressora_id, material)
);
CREATE INDEX IF NOT EXISTS idx_prod3d_potencias_org ON public.prod3d_potencias(organization_id, impressora_id);

-- ── Custos fixos mensais (100% rateados nas gramas boas) ────────────────────
CREATE TABLE IF NOT EXISTS public.prod3d_custos_fixos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  nome             text NOT NULL,
  valor_mensal     numeric NOT NULL CHECK (valor_mensal >= 0),
  categoria        text NOT NULL DEFAULT 'outros'
                   CHECK (categoria IN ('aluguel','impostos','pessoal','servicos','insumos','outros')),
  estimado         boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, nome)
);
CREATE INDEX IF NOT EXISTS idx_prod3d_fixos_org ON public.prod3d_custos_fixos(organization_id);

-- ── Filamentos (R$/kg) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prod3d_filamentos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  material         text NOT NULL,                            -- PLA, PLA-SILK, PETG-HF…
  preco_kg         numeric NOT NULL CHECK (preco_kg >= 0),
  estimado         boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, material)
);
CREATE INDEX IF NOT EXISTS idx_prod3d_filamentos_org ON public.prod3d_filamentos(organization_id);

-- ── Embalagens (preço unitário; qtd_padrao compõe a embalagem padrão/peça) ──
CREATE TABLE IF NOT EXISTS public.prod3d_embalagens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  codigo           text NOT NULL,                            -- caixa_M, fita, etiqueta…
  descricao        text NOT NULL,
  unidade          text NOT NULL DEFAULT 'un',
  preco            numeric NOT NULL CHECK (preco >= 0),
  qtd_padrao       numeric NOT NULL DEFAULT 0,               -- qtd na embalagem padrão de 1 peça
  estimado         boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, codigo)
);
CREATE INDEX IF NOT EXISTS idx_prod3d_embalagens_org ON public.prod3d_embalagens(organization_id);

-- ── SKUs (peso/tempo REAIS do fatiador) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prod3d_skus (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sku              text NOT NULL,
  projeto          text,
  gramas           numeric NOT NULL CHECK (gramas > 0),
  horas            numeric NOT NULL CHECK (horas > 0),
  material         text NOT NULL DEFAULT 'PLA',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_prod3d_skus_org ON public.prod3d_skus(organization_id);

-- ── Trilha de auditoria (append-only) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prod3d_historico (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id          uuid,
  acao             text NOT NULL,                            -- config.set, fixo.add, potencia.set…
  detalhe          jsonb NOT NULL DEFAULT '{}'::jsonb,       -- { campo, de, para, … }
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prod3d_historico_org ON public.prod3d_historico(organization_id, created_at DESC);

-- ── touch (updated_at) ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_prod3d_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text; tbls text[] := ARRAY['prod3d_config','prod3d_impressoras','prod3d_potencias',
  'prod3d_custos_fixos','prod3d_filamentos','prod3d_embalagens','prod3d_skus'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_touch ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tg_prod3d_touch()', t, t);
  END LOOP;
END $$;

-- ── RLS + GRANTs (padrão da casa — tabelas via _admin_exec_sql não herdam) ──
DO $$
DECLARE t text; tbls text[] := ARRAY['prod3d_config','prod3d_impressoras','prod3d_potencias',
  'prod3d_custos_fixos','prod3d_filamentos','prod3d_embalagens','prod3d_skus','prod3d_historico'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO public USING (organization_id IN (SELECT get_user_org_ids())) WITH CHECK (organization_id IN (SELECT get_user_org_ids()))', t || '_org_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_srv', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t || '_srv', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED — org Vazzo Comercio: dados reais do sistema local (vazzo-produtos-3d,
-- 2026-07-10). Idempotente (ON CONFLICT DO NOTHING).
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
        imp uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = org) THEN RETURN; END IF;

  INSERT INTO public.prod3d_config (organization_id) VALUES (org)
  ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO public.prod3d_impressoras (organization_id, modelo, quantidade, valor_pago, vida_util_horas, potencia_ams_w, estimado)
  VALUES (org, 'Bambu Lab A1 + AMS lite', 1, 2999, 6000, 4, true)
  ON CONFLICT (organization_id, modelo) DO NOTHING;

  SELECT id INTO imp FROM public.prod3d_impressoras WHERE organization_id = org AND modelo = 'Bambu Lab A1 + AMS lite';

  INSERT INTO public.prod3d_potencias (organization_id, impressora_id, material, watts, estimado, fonte) VALUES
    (org, imp, 'PLA',  95,  false, 'wiki oficial Bambu Lab, medido a 220V (mesa 55-65C)'),
    (org, imp, 'PETG', 130, true,  'não publicado p/ A1 — interpolado entre PLA 95W e ABS 200W oficiais; medir com tomada medidora'),
    (org, imp, 'TPU',  80,  true,  'estimado: mesa fria/30-40C e impressão lenta; medir com tomada medidora'),
    (org, imp, 'ABS',  200, false, 'wiki oficial Bambu Lab, medido a 220V (mesa 90-100C)'),
    (org, imp, 'ASA',  200, true,  'estimado = ABS oficial (mesmas temperaturas)'),
    (org, imp, 'PC',   150, false, 'wiki oficial Bambu Lab, medido a 220V'),
    (org, imp, 'PA',   190, true,  'estimado: nylon bico 260-300C, entre PC e ABS'),
    (org, imp, 'PVA',  95,  true,  'estimado = PLA (suporte solúvel, mesmas temperaturas)')
  ON CONFLICT (organization_id, impressora_id, material) DO NOTHING;

  INSERT INTO public.prod3d_custos_fixos (organization_id, nome, valor_mensal, categoria, estimado) VALUES
    (org, 'Aluguel do espaço de produção', 1200, 'aluguel', true),
    (org, 'Impostos fixos (DAS parcela fixa, IPTU rateado)', 300, 'impostos', true),
    (org, 'Funcionário de produção (salário + encargos)', 2300, 'pessoal', true),
    (org, 'Energia fixa (iluminação/escritório — NÃO impressoras)', 120, 'servicos', true),
    (org, 'Internet', 120, 'servicos', true),
    (org, 'Contador', 250, 'servicos', true),
    (org, 'Insumos gerais de bancada (cola, álcool, lixa, estilete)', 150, 'insumos', true)
  ON CONFLICT (organization_id, nome) DO NOTHING;

  INSERT INTO public.prod3d_filamentos (organization_id, material, preco_kg, estimado) VALUES
    (org, 'PLA', 85, true), (org, 'PETG', 95, true)
  ON CONFLICT (organization_id, material) DO NOTHING;

  INSERT INTO public.prod3d_embalagens (organization_id, codigo, descricao, unidade, preco, qtd_padrao, estimado) VALUES
    (org, 'caixa_P', 'Caixa de papelão P', 'un', 1.60, 0, true),
    (org, 'caixa_M', 'Caixa de papelão M', 'un', 2.50, 1, true),
    (org, 'caixa_G', 'Caixa de papelão G', 'un', 3.80, 0, true),
    (org, 'fita', 'Fita adesiva', 'm', 0.06, 2, true),
    (org, 'plastico_bolha', 'Plástico bolha', 'm', 0.90, 1, true),
    (org, 'etiqueta', 'Etiqueta de envio', 'un', 0.15, 1, true)
  ON CONFLICT (organization_id, codigo) DO NOTHING;

  INSERT INTO public.prod3d_skus (organization_id, sku, projeto, gramas, horas, material) VALUES
    (org, '09-pendente-palhinha-G', '09', 321.0, 25.0, 'PLA'),
    (org, '09-pendente-palhinha-M', '09', 97.0, 8.38, 'PLA'),
    (org, '10-pendente-bacia-G', '10', 244.9, 20.73, 'PLA'),
    (org, '10-pendente-bacia-M', '10', 76.2, 6.18, 'PLA'),
    (org, '11-pendente-bola-G', '11', 322.4, 26.82, 'PLA'),
    (org, '11-pendente-bola-M', '11', 97.3, 8.03, 'PLA'),
    (org, '13-porta-shampoo', '13', 287.0, 11.0, 'PETG'),
    (org, '14-linha-nature-beauty (kit 7 pçs)', '14', 1630.0, 51.0, 'PLA')
  ON CONFLICT (organization_id, sku) DO NOTHING;

  INSERT INTO public.prod3d_historico (organization_id, acao, detalhe)
  VALUES (org, 'seed', jsonb_build_object('origem', 'migration 20260649 — dados do sistema local vazzo-produtos-3d'));
END $$;
