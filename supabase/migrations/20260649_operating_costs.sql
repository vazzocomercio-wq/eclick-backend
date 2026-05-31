-- ═══════════════════════════════════════════════════════════════════
-- 20260649 — Custos fixos/operacionais + meta de lucro consolidado
--
-- Fundação da "Central de Resultado" (DRE viva). Aqui o cadastro dos custos
-- FIXOS/operacionais (aluguel, folha, energia, água, software…) com o driver
-- de rateio por SKU, e a meta de lucro líquido CONSOLIDADO da org (governador
-- de carteira que o Ads Performance Agent vai consumir p/ derivar o ACOS-alvo).
--
-- ⚠️ Tabelas criadas via _admin_exec_sql NÃO herdam default privileges →
-- GRANT explícito. Acesso é sempre via API (SupabaseAuthGuard → supabaseAdmin,
-- service_role, filtra org_id na query) — service_role only, como public_audits.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.operating_costs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  label            varchar(120) NOT NULL,
  -- categoria livre com defaults sugeridos no front
  category         varchar(40)  NOT NULL DEFAULT 'outros',
  -- valor em R$ (BRL) — mesma unidade do motor de margem
  amount           numeric(14,2) NOT NULL CHECK (amount >= 0),
  -- recorrência: mensal (padrão), única (cai no mês do valid_from) ou anual (÷12 no mês)
  recurrence       varchar(12)  NOT NULL DEFAULT 'monthly'
                     CHECK (recurrence IN ('monthly','once','annual')),
  -- driver de rateio do custo por SKU. Default = participação na MARGEM de
  -- contribuição (o mais justo). Editável por categoria (ABC-lite).
  allocation_driver varchar(24) NOT NULL DEFAULT 'contribution_margin'
                     CHECK (allocation_driver IN
                       ('contribution_margin','revenue','units','orders','equal','manual')),
  -- vigência (custo só conta dentro da janela)
  valid_from       date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  valid_to         date,                       -- null = vigente
  active           boolean NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operating_costs_org
  ON public.operating_costs (organization_id, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.operating_costs TO service_role;

-- Meta de lucro líquido CONSOLIDADO da org (governador de carteira do Ads Agent).
-- NÃO é piso por produto — é a trava da média ponderada final. Default 15%.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS target_net_margin_pct numeric(5,2) NOT NULL DEFAULT 15;
