-- ════════════════════════════════════════════════════════════════════════
-- Sprint 7 Batch A — Módulo Financeiro: contas a pagar
-- ════════════════════════════════════════════════════════════════════════
-- Tabela GENÉRICA que serve qualquer fluxo (dropship OC, importação,
-- manual, serviços, aluguel, impostos, etc.). Não acopla ao dropship.
--
-- Polimorfismo via source_type + source_id:
--   - dropship_oc        → source_id = dropship_purchase_orders.id
--   - purchase_order     → source_id = purchase_orders.id (importação)
--   - manual             → source_id = NULL
--   - service/rent/tax/other → source_id = NULL ou referência arbitrária
--
-- Workflow:
--   1. OC dropship aprovada → DropshipService cria accounts_payable
--      automaticamente (status='pending', due_date=oc.due_date,
--      amount=oc.net_total) e atualiza oc.payable_id.
--   2. Operador marca pago via UI: PATCH /financeiro/payables/:id/pay
--      com payment_proof_url + reference → status='paid' + paid_at.
--   3. Lista "A pagar" filtra status IN (pending, partial, overdue).
--   4. Cron diário marca como 'overdue' se due_date < today.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS accounts_payable (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),

  -- Identificação
  payable_number TEXT NOT NULL,
  description TEXT NOT NULL,

  -- Origem polimórfica
  source_type TEXT NOT NULL CHECK (source_type IN (
    'dropship_oc',     -- OC dropship (auto-criado quando OC aprovada)
    'purchase_order',  -- Ordem de importação (futura integração)
    'manual',          -- Lançamento manual
    'service',         -- Serviços recorrentes
    'rent',            -- Aluguel
    'tax',             -- Impostos
    'salary',          -- Folha
    'utility',         -- Água/luz/internet
    'other'
  )),
  source_id UUID,                -- referência polimórfica (sem FK rígida)

  -- Beneficiário (denormalizado pra resilience histórica)
  supplier_id UUID REFERENCES suppliers(id),
  beneficiary_name TEXT NOT NULL,
  beneficiary_doc TEXT,

  -- Valores
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  paid_amount NUMERIC DEFAULT 0 CHECK (paid_amount >= 0),
  remaining_amount NUMERIC GENERATED ALWAYS AS (amount - COALESCE(paid_amount, 0)) STORED,

  -- Datas
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  paid_at TIMESTAMPTZ,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',    -- Aguardando pagamento
    'partial',    -- Pago parcialmente
    'paid',       -- Pago integralmente
    'overdue',    -- Vencido sem pagamento
    'cancelled'   -- Cancelado
  )),

  -- Pagamento
  payment_method TEXT CHECK (payment_method IN (
    'pix', 'boleto', 'transfer', 'check', 'cash', 'credit_card', 'debit_card', 'other'
  )),
  payment_reference TEXT,
  payment_proof_url TEXT,
  payment_proof_storage_path TEXT,

  -- Categorização contábil
  category TEXT,                 -- ex: 'CMV', 'Despesa Operacional', 'Tributos'
  cost_center TEXT,              -- ex: 'Vendas', 'Logística', 'Administrativo'

  -- Metadados
  notes TEXT,
  metadata JSONB DEFAULT '{}',

  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identificador único por org (não global)
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_payable_number
  ON accounts_payable(organization_id, payable_number);

CREATE INDEX IF NOT EXISTS idx_accounts_payable_org
  ON accounts_payable(organization_id);
CREATE INDEX IF NOT EXISTS idx_accounts_payable_status
  ON accounts_payable(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_accounts_payable_due_date
  ON accounts_payable(due_date)
  WHERE status IN ('pending', 'partial', 'overdue');
CREATE INDEX IF NOT EXISTS idx_accounts_payable_supplier
  ON accounts_payable(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_payable_source
  ON accounts_payable(source_type, source_id) WHERE source_id IS NOT NULL;
-- Idempotência: cada source só pode gerar 1 payable
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_payable_source_unique
  ON accounts_payable(source_type, source_id) WHERE source_id IS NOT NULL;

GRANT ALL ON TABLE public.accounts_payable TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.accounts_payable TO authenticated;
