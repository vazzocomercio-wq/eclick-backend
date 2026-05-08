# Dropship Center IA — Especificação Técnica Completa

**Módulo F9 do e-Click SaaS** (eclick.app.br)

| Item | Valor |
|---|---|
| Versão | 1.1 (Opção C + 3 refinamentos) |
| Data | 2026-05-08 |
| Stack | Next.js (Netlify) + NestJS (Railway) + Supabase Postgres |
| Status | Spec aprovada — Sprint 1 em implementação |

---

## 📋 Decisões Arquiteturais (2026-05-08)

A spec original propunha 17 tabelas `dropship_*` independentes. Após auditar o estado real do banco (ver §"Estado Atual" abaixo), foi decidida **Opção C com 3 refinamentos**:

### Estado atual relevante

| Já existe | Schema | Decisão |
|---|---|---|
| `suppliers` | name, legal_name, tax_id, contact_*, payment_terms, payment_method, default_lead_time_days, rating, on_time_delivery_rate, supplier_type, country, currency | **Reusar** — é o cadastro genérico de fornecedor (importação E dropship) |
| `supplier_products` | supplier_id, product_id, unit_cost, lead_time_days, safety_days, moq, is_preferred, supplier_sku, price_tiers | **Estender** com 6 colunas dropship-específicas |
| `purchase_orders` | po_number, status (`draft→pending→ordered→in_production→in_transit→customs→received`), incoterm, container_number, bl_number | **NÃO reusar** — é fluxo de **importação** (China/exterior). OC dropship é diária/simples, conceito diferente |
| `purchase_order_items` | quantity, unit_cost, quantity_received | **NÃO reusar** (idem) |
| `products.cost_price`, `products.preferred_supplier_id`, `products.supply_type` | já existem | OK |

### Os 3 refinamentos (vs spec v1.0)

**Refinamento 1 — Estender `supplier_products` em vez de criar `dropship_partner_products`.**
A `supplier_products` já tem 90% do shape proposto. Adicionar 6 colunas é mais limpo do que tabela paralela. Os campos novos são genericamente úteis (estoque do fornecedor é informação útil mesmo fora de dropship).

**Refinamento 2 — Renomear `dropship_account_partners` → `seller_account_suppliers`.**
Mais semântico. A tabela mapeia "esta conta de marketplace despacha pelo galpão deste supplier".

**Refinamento 3 — Padrão de nomenclatura por escopo.**
- `supplier_*` — genérico, aplica a qualquer fornecedor (importação E dropship)
- `dropship_*` — exclusivo do fluxo dropship diário (OCs, devoluções, scores, etc.)
- `purchase_*` — fluxo de importação (já existente, não mexer)

### Mapeamento spec original → schema final

| Spec original (v1.0) | Schema final (v1.1) | Status |
|---|---|---|
| `dropship_partners` | `suppliers` + `supplier_dropship_profiles` (1:1) | Reusa + cria perfil |
| `dropship_partner_contracts` | (deferido — campos críticos vivem em `supplier_dropship_profiles`; versionamento na v2) | Diferido |
| `dropship_account_partners` | `seller_account_suppliers` | Renomeado |
| `dropship_partner_products` | ALTER `supplier_products` (+6 colunas) | Estendido |
| `dropship_cost_history` | `supplier_cost_history` (genérico) | Renomeado |
| `dropship_order_identifications` | `dropship_order_identifications` (FK `supplier_id`) | Mantido |
| `dropship_sync_logs` | `dropship_sync_logs` (FK `supplier_id`) | Mantido |
| `dropship_summary` | `dropship_summary` | Mantido |
| `dropship_purchase_orders` | `dropship_purchase_orders` (FK `supplier_id`) | Mantido |
| `dropship_purchase_order_items` | `dropship_purchase_order_items` | Mantido |
| `dropship_partner_portal_sessions` | `dropship_partner_portal_sessions` (FK `supplier_id`) | Mantido |
| `dropship_oc_notifications` | `dropship_oc_notifications` | Mantido |
| `dropship_returns` | `dropship_returns` (FK `supplier_id`) | Mantido |
| `dropship_partner_credits` | `dropship_partner_credits` (FK `supplier_id`) | Mantido |
| `dropship_disputes` | `dropship_disputes` (FK `supplier_id`) | Mantido |
| `dropship_partner_scores` | `dropship_partner_scores` (FK `supplier_id`) | Mantido |
| `dropship_divergences` | `dropship_divergences` (FK `supplier_id`) | Mantido |

**Total tabelas novas: 15** (3 `supplier_*` + 12 `dropship_*`) + 1 ALTER.

### UI vs DB

UI continua "Parceiro Dropship" (PT-BR amigável). Backend usa `supplier`/`supplier_id` na tabela e expõe rotas como `/dropship/partners` (pra clareza de domínio). Service faz JOIN supplier + profile.

### Cadastro em transação atômica

Frontend chama 1 endpoint, backend cria 2 registros:

```typescript
async createDropshipPartner(orgId: string, data: CreateDropshipPartnerDto) {
  return await this.db.transaction(async (tx) => {
    const supplier = await tx.from('suppliers').insert({
      organization_id: orgId,
      name: data.name,
      legal_name: data.legal_name,
      tax_id: data.cnpj,
      contact_email: data.contact_email,
      contact_phone: data.contact_phone,
      payment_terms: data.payment_term,
      payment_method: data.payment_method,
      supplier_type: 'nacional', // dropship é sempre nacional na v1
      currency: 'BRL',
    }).select().single();

    const profile = await tx.from('supplier_dropship_profiles').insert({
      organization_id: orgId,
      supplier_id: supplier.id,
      cutoff_time: data.cutoff_time,
      integration_type: data.integration_type,
      oc_generation_time: data.oc_generation_time,
      notification_email: data.notification_email,
      notification_whatsapp: data.notification_whatsapp,
    }).select().single();

    return { supplier, profile };
  });
}
```

UI continua simples: 1 formulário, 1 botão "Criar Parceiro". Backend faz 2 inserts atômicos.

---

## Visão do Módulo

Central de controle dropship que gerencia o ciclo completo: cadastro de parceiros, sync de catálogo/estoque/custos, identificação de pedidos dropship, geração diária de Ordem de Compra (OC), aprovação pelo parceiro, lançamento financeiro, devoluções, abatimentos e auditoria. Integrado com Quality Center, Campaign Center e Active.

### Princípio Central

> Vendeu → Despachou → Conferiu → OC do dia → Aprovou → Pagou → Devolução abate.
> Cada etapa rastreável, cada divergência capturada.

### Os 3 buracos silenciosos do dropship que o módulo fecha

| Problema | Como o módulo resolve |
|---|---|
| Estoque desatualizado | Sync periódico + pausa automática de anúncio quando parceiro zera |
| Custo mal controlado | Trava de custo vigente no momento da OC + auditoria de divergências |
| Devolução sem abatimento | Detecção automática via webhook ML/Shopee + régua de 4 cenários |

## Entregas em 4 Camadas

| # | Nome | Escopo | Sprints |
|---|---|---|---|
| **D1** | Fundação + Visibilidade | Cadastro parceiros + vínculo + identificação de pedidos dropship | 3 |
| **D2** | OC + Financeiro | Pré-OC + cutoff + geração + portal parceiro + contas a pagar | 3-4 |
| **D3** | Devoluções + Abatimentos | Detecção via marketplace + régua de 4 cenários + créditos | 2-3 |
| **D4** | IA + Score + Auditoria | Score parceiro + copiloto + detecção divergências + previsão | 2 |

---

## CAMADA D1 — Fundação + Visibilidade

### Objetivo

Cadastrar parceiros (reusando `suppliers`), vincular contas de marketplace a suppliers, estender catálogo com campos dropship, e identificar automaticamente quais pedidos são dropship.

### Migration Sprint 1 Batch A — `20260508_dropship_foundation.sql`

```sql
-- ============================================================
-- Dropship Center — Sprint 1 Batch A
-- ALTER supplier_products + criar 2 tabelas novas
-- ============================================================

-- 1. Estender supplier_products com campos dropship
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_stock INTEGER DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_reserved INTEGER DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_available INTEGER
  GENERATED ALWAYS AS (partner_stock - partner_reserved) STORED;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS master_sku TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_packaging_cost NUMERIC DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS partner_handling_cost NUMERIC DEFAULT 0;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS last_stock_change_at TIMESTAMPTZ;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS last_cost_change_at TIMESTAMPTZ;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS dropship_status TEXT DEFAULT 'active'
  CHECK (dropship_status IN ('active', 'paused', 'unavailable', 'discontinued', 'pending_validation'));

CREATE INDEX IF NOT EXISTS idx_supplier_products_master_sku ON supplier_products(master_sku);
CREATE INDEX IF NOT EXISTS idx_supplier_products_dropship_status ON supplier_products(dropship_status);

-- 2. Perfil dropship (1:1 com supplier — campos específicos do fluxo)
CREATE TABLE supplier_dropship_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  -- Operação dropship
  notification_email TEXT NOT NULL,
  notification_whatsapp TEXT,
  operations_contact TEXT,
  operations_phone TEXT,
  warehouse_address JSONB,
  -- Tipo de integração
  integration_type TEXT NOT NULL DEFAULT 'manual' CHECK (integration_type IN (
    'manual', 'spreadsheet', 'api', 'csv_email', 'sftp',
    'erp_bling', 'erp_tiny', 'erp_omie'
  )),
  integration_config JSONB DEFAULT '{}',
  -- Janela operacional
  cutoff_time TIME DEFAULT '14:00',
  ship_lead_days INTEGER DEFAULT 1,
  weekend_processing BOOLEAN DEFAULT false,
  holidays_processing BOOLEAN DEFAULT false,
  -- Janela de OC
  oc_generation_time TIME DEFAULT '22:00',
  oc_preview_open_time TIME DEFAULT '12:00',
  oc_review_cutoff_time TIME DEFAULT '21:00',
  -- Estratégia comercial (campos do "contrato" v1 — versionamento na v2)
  cost_strategy TEXT NOT NULL DEFAULT 'current_table' CHECK (cost_strategy IN (
    'current_table', 'at_sale_date', 'at_ship_date', 'fixed_per_period', 'per_campaign'
  )),
  return_credit_strategy TEXT DEFAULT 'next_oc' CHECK (return_credit_strategy IN (
    'same_oc', 'next_oc', 'separate_invoice'
  )),
  return_responsibility JSONB DEFAULT '{}',
  cost_divergence_tolerance_pct NUMERIC DEFAULT 5,
  stock_divergence_tolerance_units INTEGER DEFAULT 2,
  marketplaces_supported JSONB DEFAULT '[]',
  -- Status dropship
  dropship_status TEXT NOT NULL DEFAULT 'active' CHECK (dropship_status IN (
    'active', 'paused', 'inactive', 'pending_setup'
  )),
  paused_reason TEXT,
  -- Métricas calculadas (atualizadas via cron)
  active_dropship_skus INTEGER DEFAULT 0,
  orders_30d INTEGER DEFAULT 0,
  revenue_30d NUMERIC DEFAULT 0,
  cmv_30d NUMERIC DEFAULT 0,
  pending_payable NUMERIC DEFAULT 0,
  -- Score (preenchido pela D4)
  partner_score INTEGER CHECK (partner_score >= 0 AND partner_score <= 100),
  score_breakdown JSONB DEFAULT '{}',
  -- Documentos
  contract_pdf_url TEXT,
  contract_pdf_storage_path TEXT,
  -- Metadados
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_supplier_dropship_profiles_supplier ON supplier_dropship_profiles(supplier_id);
CREATE INDEX idx_supplier_dropship_profiles_org ON supplier_dropship_profiles(organization_id);
CREATE INDEX idx_supplier_dropship_profiles_status ON supplier_dropship_profiles(dropship_status);

-- 3. Mapeamento conta marketplace ↔ supplier
CREATE TABLE seller_account_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL CHECK (marketplace IN (
    'mercado_livre', 'shopee', 'amazon', 'magalu', 'others'
  )),
  seller_id BIGINT,
  shopee_shop_id TEXT,
  amazon_seller_id TEXT,
  account_label TEXT, -- Nome amigável (ex: "Vazzo ML", "EsLar Shopee")
  is_default BOOLEAN DEFAULT true,
  active_since DATE NOT NULL DEFAULT CURRENT_DATE,
  active_until DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_seller_account_suppliers_org ON seller_account_suppliers(organization_id);
CREATE INDEX idx_seller_account_suppliers_supplier ON seller_account_suppliers(supplier_id);
CREATE UNIQUE INDEX idx_seller_account_suppliers_default
  ON seller_account_suppliers(
    organization_id, marketplace,
    COALESCE(seller_id::text, ''),
    COALESCE(shopee_shop_id, ''),
    COALESCE(amazon_seller_id, '')
  )
  WHERE is_default = true AND active_until IS NULL;

-- GRANTs (gotcha §11.J skill vazzo-direct: tables criadas via _admin_exec_sql precisam GRANT explícito)
GRANT ALL ON TABLE public.supplier_dropship_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_dropship_profiles TO authenticated;
GRANT ALL ON TABLE public.seller_account_suppliers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.seller_account_suppliers TO authenticated;
```

### Migration Sprint 2 Batch A — `20260509_dropship_catalog_sync.sql` (Sprint 2)

```sql
-- supplier_cost_history (histórico genérico de custos por supplier_product)
CREATE TABLE supplier_cost_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_product_id UUID NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,
  cost_value NUMERIC NOT NULL,
  cost_packaging NUMERIC DEFAULT 0,
  cost_handling NUMERIC DEFAULT 0,
  cost_total NUMERIC NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_until TIMESTAMPTZ,
  change_reason TEXT,
  change_source TEXT CHECK (change_source IN (
    'manual', 'spreadsheet_import', 'api_sync', 'partner_notification'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_supplier_cost_history_product ON supplier_cost_history(supplier_product_id);
CREATE INDEX idx_supplier_cost_history_effective ON supplier_cost_history(effective_from, effective_until);

-- dropship_sync_logs (logs de sync com fornecedores dropship)
CREATE TABLE dropship_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  supplier_id UUID REFERENCES suppliers(id),
  sync_type TEXT NOT NULL CHECK (sync_type IN (
    'catalog_full', 'catalog_incremental', 'stock', 'cost',
    'spreadsheet_import', 'api_pull', 'manual'
  )),
  source TEXT,
  source_file_url TEXT,
  products_processed INTEGER DEFAULT 0,
  products_created INTEGER DEFAULT 0,
  products_updated INTEGER DEFAULT 0,
  products_failed INTEGER DEFAULT 0,
  cost_changes_count INTEGER DEFAULT 0,
  stock_changes_count INTEGER DEFAULT 0,
  significant_cost_changes JSONB DEFAULT '[]',
  significant_stock_changes JSONB DEFAULT '[]',
  out_of_stock_skus TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'failed', 'partial'
  )),
  error_message TEXT,
  duration_seconds INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_dropship_sync_supplier ON dropship_sync_logs(supplier_id);
CREATE INDEX idx_dropship_sync_status ON dropship_sync_logs(status);

GRANT ALL ON TABLE public.supplier_cost_history TO service_role;
GRANT SELECT, INSERT ON TABLE public.supplier_cost_history TO authenticated;
GRANT ALL ON TABLE public.dropship_sync_logs TO service_role;
GRANT SELECT, INSERT ON TABLE public.dropship_sync_logs TO authenticated;
```

### Migration Sprint 3 Batch A — `20260510_dropship_orders.sql` (Sprint 3)

```sql
-- Identificação de pedidos como dropship
CREATE TABLE dropship_order_identifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  ml_pack_id TEXT,
  ml_order_id TEXT,
  ml_shipment_id TEXT,
  shopee_order_id TEXT,
  amazon_order_id TEXT,
  -- Vínculo dropship
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  supplier_product_id UUID REFERENCES supplier_products(id),
  product_id UUID REFERENCES products(id),
  -- Snapshot do momento da identificação
  ml_item_id TEXT,
  partner_sku TEXT NOT NULL, -- = supplier_products.supplier_sku
  master_sku TEXT,
  quantity INTEGER NOT NULL,
  -- Custos snapshot
  cost_at_sale NUMERIC,
  sale_price NUMERIC,
  estimated_cost_at_oc NUMERIC,
  estimated_margin NUMERIC,
  -- Status
  marketplace_status TEXT,
  shipping_status TEXT,
  payment_status TEXT,
  dropship_status TEXT NOT NULL DEFAULT 'identified' CHECK (dropship_status IN (
    'identified', 'awaiting_shipment', 'shipped', 'shipped_confirmed',
    'eligible_for_oc', 'in_oc_draft', 'in_oc_generated', 'in_oc_approved',
    'in_payable', 'paid', 'cancelled', 'returned', 'on_hold', 'excluded'
  )),
  hold_reason TEXT,
  -- Datas
  identified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at TIMESTAMPTZ,
  shipment_confirmed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  oc_id UUID, -- Preenchido quando entra em OC (D2)
  -- Metadados
  raw_marketplace_data JSONB,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dropship_orders_org ON dropship_order_identifications(organization_id);
CREATE INDEX idx_dropship_orders_supplier ON dropship_order_identifications(supplier_id);
CREATE INDEX idx_dropship_orders_order ON dropship_order_identifications(order_id);
CREATE INDEX idx_dropship_orders_status ON dropship_order_identifications(dropship_status);
CREATE INDEX idx_dropship_orders_eligible ON dropship_order_identifications(dropship_status)
  WHERE dropship_status = 'eligible_for_oc';
CREATE INDEX idx_dropship_orders_shipped ON dropship_order_identifications(shipped_at);
CREATE INDEX idx_dropship_orders_oc ON dropship_order_identifications(oc_id) WHERE oc_id IS NOT NULL;

-- dropship_summary (dashboard agregado)
CREATE TABLE dropship_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id),
  active_partners_count INTEGER DEFAULT 0,
  active_dropship_skus INTEGER DEFAULT 0,
  active_dropship_listings INTEGER DEFAULT 0,
  shipped_today INTEGER DEFAULT 0,
  shipped_today_value NUMERIC DEFAULT 0,
  pending_oc_today_count INTEGER DEFAULT 0,
  pending_oc_today_value NUMERIC DEFAULT 0,
  out_of_stock_skus_count INTEGER DEFAULT 0,
  low_stock_skus_count INTEGER DEFAULT 0,
  pending_payable_value NUMERIC DEFAULT 0,
  next_7d_payable_value NUMERIC DEFAULT 0,
  next_30d_payable_value NUMERIC DEFAULT 0,
  open_returns_count INTEGER DEFAULT 0,
  open_returns_value NUMERIC DEFAULT 0,
  open_divergences_count INTEGER DEFAULT 0,
  open_divergences_value NUMERIC DEFAULT 0,
  pending_partner_credits NUMERIC DEFAULT 0,
  avg_partner_score NUMERIC,
  partners_at_risk_count INTEGER DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON TABLE public.dropship_order_identifications TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dropship_order_identifications TO authenticated;
GRANT ALL ON TABLE public.dropship_summary TO service_role;
GRANT SELECT ON TABLE public.dropship_summary TO authenticated;
```

### Endpoints D1

```
-- Parceiros (cria 2 inserts atômicos: supplier + profile) --
GET    /dropship/partners                       → Listar (JOIN supplier + profile)
POST   /dropship/partners                       → Criar (transaction)
GET    /dropship/partners/:id                   → Detalhe + métricas
PATCH  /dropship/partners/:id                   → Atualizar (UPDATE em ambas tabelas)
DELETE /dropship/partners/:id                   → Arquivar (soft-delete via status)

-- Vínculo conta-supplier --
GET    /dropship/account-suppliers              → Listar vínculos
POST   /dropship/account-suppliers              → Criar vínculo
PATCH  /dropship/account-suppliers/:id          → Editar
DELETE /dropship/account-suppliers/:id          → Desvincular (active_until = now)

-- Catálogo (estendido em supplier_products) --
GET    /dropship/partner-products               → Listar (filtros: supplier_id, dropship_status, master_sku)
POST   /dropship/partner-products               → Criar manualmente
PATCH  /dropship/partner-products/:id           → Atualizar
DELETE /dropship/partner-products/:id           → Arquivar
POST   /dropship/partner-products/import        → Importar planilha (CSV/XLSX)
GET    /dropship/partner-products/import/:jobId → Status da importação

-- Sync --
POST   /dropship/partners/:id/sync              → Sync manual
GET    /dropship/partners/:id/sync/last         → Último sync
GET    /dropship/sync-logs                      → Histórico

-- Pedidos dropship --
GET    /dropship/orders                         → Listar (filtros)
GET    /dropship/orders/:id                     → Detalhe
PATCH  /dropship/orders/:id                     → Atualizar status manual
POST   /dropship/orders/identify                → Forçar re-identificação (cron)
POST   /dropship/orders/:id/hold                → Suspender
POST   /dropship/orders/:id/release             → Liberar de hold

-- Dashboard --
GET    /dropship/dashboard                      → Resumo executivo
GET    /dropship/today                          → Vendas dropship do dia
```

### Telas D1

```
/dashboard/dropship                              → Dashboard executivo
/dashboard/dropship/partners                     → Lista de parceiros
/dashboard/dropship/partners/new                 → Criar parceiro (form único)
/dashboard/dropship/partners/[id]                → Detalhe
/dashboard/dropship/partners/[id]/products       → Catálogo dropship
/dashboard/dropship/partners/[id]/import         → Importar planilha
/dashboard/dropship/partners/[id]/orders         → Pedidos do parceiro
/dashboard/dropship/orders                       → Todos pedidos dropship
/dashboard/dropship/orders/today                 → Vendas dropship do dia
/dashboard/dropship/account-suppliers            → Mapeamento conta ↔ supplier
/dashboard/dropship/sync-logs                    → Histórico de sincronizações
```

---

## CAMADA D2 — OC + Financeiro

### Objetivo

Gerar Pré-OC durante o dia (visualização live), cutoff às 21h (trava edição), geração às 22h (cria OC oficial), envio ao parceiro (e-mail + WhatsApp), portal do parceiro com URL+token para aprovação, transformação em contas a pagar.

### Migration `20260511_dropship_oc_financial.sql`

```sql
-- 1. Ordens de Compra dropship (NÃO confundir com purchase_orders de importação)
CREATE TABLE dropship_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  -- Identificação
  oc_number TEXT NOT NULL UNIQUE, -- "DOC-2026-05-08-VAZZO-FORNEC_A-001"
  marketplace TEXT,
  marketplace_account_label TEXT,
  seller_id BIGINT,
  shopee_shop_id TEXT,
  amazon_seller_id TEXT,
  -- Período
  reference_date DATE NOT NULL,
  generation_date TIMESTAMPTZ NOT NULL,
  due_date DATE NOT NULL,
  -- Valores
  items_count INTEGER NOT NULL DEFAULT 0,
  units_count INTEGER NOT NULL DEFAULT 0,
  gross_total NUMERIC NOT NULL DEFAULT 0,
  return_credits NUMERIC DEFAULT 0,
  cancellation_credits NUMERIC DEFAULT 0,
  warranty_credits NUMERIC DEFAULT 0,
  divergence_credits NUMERIC DEFAULT 0,
  other_credits NUMERIC DEFAULT 0,
  total_credits NUMERIC GENERATED ALWAYS AS (
    return_credits + cancellation_credits + warranty_credits +
    divergence_credits + other_credits
  ) STORED,
  net_total NUMERIC NOT NULL DEFAULT 0,
  -- Status
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'preview_locked', 'generating', 'generated', 'sent',
    'viewed', 'approved', 'approved_with_notes', 'rejected',
    'in_payable', 'paid', 'partially_paid', 'cancelled', 'on_hold'
  )),
  -- Aprovação parceiro
  sent_to_partner_at TIMESTAMPTZ,
  partner_viewed_at TIMESTAMPTZ,
  partner_approved_at TIMESTAMPTZ,
  partner_approval_notes TEXT,
  partner_rejection_reason TEXT,
  partner_approved_by_name TEXT,
  partner_approved_by_email TEXT,
  -- Aprovação interna
  internal_approved_at TIMESTAMPTZ,
  internal_approved_by UUID REFERENCES auth.users(id),
  -- Pagamento
  paid_at TIMESTAMPTZ,
  payment_proof_url TEXT,
  payment_method TEXT,
  payment_reference TEXT,
  -- Lançamento financeiro
  payable_id UUID,
  -- Documentos
  pdf_url TEXT,
  pdf_storage_path TEXT,
  excel_url TEXT,
  excel_storage_path TEXT,
  -- Metadados
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dropship_oc_org ON dropship_purchase_orders(organization_id);
CREATE INDEX idx_dropship_oc_supplier ON dropship_purchase_orders(supplier_id);
CREATE INDEX idx_dropship_oc_status ON dropship_purchase_orders(status);
CREATE INDEX idx_dropship_oc_due_date ON dropship_purchase_orders(due_date)
  WHERE status IN ('approved', 'in_payable', 'partially_paid');
CREATE INDEX idx_dropship_oc_reference_date ON dropship_purchase_orders(reference_date);

-- 2. Itens da OC
CREATE TABLE dropship_purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oc_id UUID NOT NULL REFERENCES dropship_purchase_orders(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  identification_id UUID NOT NULL REFERENCES dropship_order_identifications(id),
  order_id UUID REFERENCES orders(id),
  ml_pack_id TEXT,
  ml_order_id TEXT,
  ml_shipment_id TEXT,
  marketplace TEXT NOT NULL,
  product_id UUID REFERENCES products(id),
  supplier_product_id UUID REFERENCES supplier_products(id),
  partner_sku TEXT NOT NULL,
  master_sku TEXT,
  product_name TEXT NOT NULL,
  variation_label TEXT,
  quantity INTEGER NOT NULL,
  -- Custo (snapshot da tabela vigente — current_table strategy)
  unit_cost NUMERIC NOT NULL,
  packaging_cost NUMERIC DEFAULT 0,
  handling_cost NUMERIC DEFAULT 0,
  unit_total_cost NUMERIC GENERATED ALWAYS AS (
    unit_cost + packaging_cost + handling_cost
  ) STORED,
  line_total NUMERIC GENERATED ALWAYS AS (
    (unit_cost + packaging_cost + handling_cost) * quantity
  ) STORED,
  sale_date TIMESTAMPTZ NOT NULL,
  shipped_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'included' CHECK (status IN (
    'included', 'pending_credit', 'credited', 'disputed', 'excluded'
  )),
  notes TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oc_items_oc ON dropship_purchase_order_items(oc_id);
CREATE INDEX idx_oc_items_identification ON dropship_purchase_order_items(identification_id);
CREATE INDEX idx_oc_items_partner_sku ON dropship_purchase_order_items(partner_sku);

-- 3. Acessos do parceiro ao portal (URL + token, expira 72h)
CREATE TABLE dropship_partner_portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  oc_id UUID REFERENCES dropship_purchase_orders(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL UNIQUE, -- 32+ chars random
  expires_at TIMESTAMPTZ NOT NULL, -- Default: now() + 72h
  can_approve BOOLEAN DEFAULT true,
  can_dispute BOOLEAN DEFAULT true,
  can_view_history BOOLEAN DEFAULT false,
  first_accessed_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER DEFAULT 0,
  ip_addresses TEXT[] DEFAULT '{}',
  user_agents TEXT[] DEFAULT '{}',
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  approver_name TEXT,
  approver_email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'used', 'expired', 'revoked'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_portal_sessions_supplier ON dropship_partner_portal_sessions(supplier_id);
CREATE INDEX idx_portal_sessions_oc ON dropship_partner_portal_sessions(oc_id);
CREATE INDEX idx_portal_sessions_token ON dropship_partner_portal_sessions(access_token)
  WHERE status = 'active';

-- 4. Notificações (e-mail + WhatsApp)
CREATE TABLE dropship_oc_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  oc_id UUID NOT NULL REFERENCES dropship_purchase_orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms')),
  recipient TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'oc_generated', 'oc_reminder_24h', 'oc_reminder_48h', 'oc_overdue',
    'payment_reminder', 'payment_completed', 'cost_change_alert', 'stock_out_alert'
  )),
  subject TEXT,
  body TEXT,
  attachments JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sent', 'delivered', 'read', 'failed'
  )),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  error_message TEXT,
  provider TEXT,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oc_notif_oc ON dropship_oc_notifications(oc_id);
CREATE INDEX idx_oc_notif_status ON dropship_oc_notifications(status);

-- GRANTs
GRANT ALL ON TABLE public.dropship_purchase_orders TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dropship_purchase_orders TO authenticated;
GRANT ALL ON TABLE public.dropship_purchase_order_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dropship_purchase_order_items TO authenticated;
GRANT ALL ON TABLE public.dropship_partner_portal_sessions TO service_role;
GRANT SELECT ON TABLE public.dropship_partner_portal_sessions TO authenticated;
GRANT ALL ON TABLE public.dropship_oc_notifications TO service_role;
GRANT SELECT ON TABLE public.dropship_oc_notifications TO authenticated;
```

### Cron de Geração

`@Cron('0 22 * * *', { name: 'dropship-oc-generation' })` em `DropshipOCGenerationService.generateDailyOCs()`.

Lê `payment_term` do `suppliers.payment_terms` (já existe — ex: `'45'` = D+45).

### Endpoints D2

```
-- Pré-OC --
GET    /dropship/oc/preview                     → Prévia das OCs do dia
GET    /dropship/oc/preview/:supplierId         → Prévia de 1 supplier
POST   /dropship/oc/preview/refresh             → Forçar refresh
POST   /dropship/oc/preview/exclude-item        → Remover item
POST   /dropship/oc/preview/include-item        → Adicionar item

-- Geração --
POST   /dropship/oc/generate                    → Forçar geração agora
POST   /dropship/oc/generate/:supplierId        → Gerar para 1 supplier
GET    /dropship/oc/generation-status           → Status da geração

-- OCs --
GET    /dropship/oc                             → Listar (filtros)
GET    /dropship/oc/:id                         → Detalhe
PATCH  /dropship/oc/:id                         → Editar (limited)
POST   /dropship/oc/:id/cancel                  → Cancelar
POST   /dropship/oc/:id/regenerate-documents    → Regenerar PDF/Excel

-- Envio --
POST   /dropship/oc/:id/send                    → Enviar manual
POST   /dropship/oc/:id/resend                  → Reenviar
GET    /dropship/oc/:id/notifications           → Notificações enviadas

-- Portal do parceiro (público com token) --
GET    /portal/oc/:token                        → Visualizar (sem login)
POST   /portal/oc/:token/approve                → Aprovar
POST   /portal/oc/:token/reject                 → Rejeitar
POST   /portal/oc/:token/dispute-item           → Contestar
POST   /portal/oc/:token/upload-nf              → Anexar NF

-- Financeiro --
POST   /dropship/oc/:id/to-payable              → Lançar em contas a pagar
GET    /dropship/payables                       → OCs em contas a pagar
POST   /dropship/oc/:id/mark-paid               → Marcar pago
POST   /dropship/oc/:id/upload-payment-proof    → Comprovante pagamento
```

---

## CAMADA D3 — Devoluções + Abatimentos

### Objetivo

Detectar devoluções/cancelamentos via marketplace (webhook ou pull), aplicar régua de 4 cenários, gerar créditos automáticos, abater na próxima OC.

### Migration `20260512_dropship_returns_credits.sql`

```sql
-- Devoluções e cancelamentos
CREATE TABLE dropship_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  identification_id UUID REFERENCES dropship_order_identifications(id),
  order_id UUID REFERENCES orders(id),
  ml_pack_id TEXT,
  ml_order_id TEXT,
  ml_shipment_id TEXT,
  shopee_order_id TEXT,
  marketplace TEXT NOT NULL,
  original_oc_id UUID REFERENCES dropship_purchase_orders(id),
  original_oc_item_id UUID REFERENCES dropship_purchase_order_items(id),
  return_type TEXT NOT NULL CHECK (return_type IN (
    'cancellation', 'return_buyer_regret', 'return_defective',
    'return_wrong_item', 'return_damaged', 'return_not_delivered',
    'return_incomplete', 'warranty_claim', 'reclamation_refund',
    'chargeback', 'partner_negotiated'
  )),
  source TEXT NOT NULL CHECK (source IN (
    'marketplace_webhook', 'marketplace_sync', 'sac_module',
    'manual', 'partner_request'
  )),
  external_id TEXT, -- ID da reclamação no marketplace (idempotência)
  return_amount NUMERIC NOT NULL,
  return_quantity INTEGER NOT NULL,
  responsibility TEXT CHECK (responsibility IN (
    'partner', 'seller', 'shared', 'buyer', 'undefined'
  )),
  responsibility_split JSONB,
  status TEXT NOT NULL DEFAULT 'opened' CHECK (status IN (
    'opened', 'in_transit_back', 'received', 'analyzed', 'approved',
    'credit_pending', 'credit_applied', 'disputed', 'rejected', 'closed'
  )),
  credit_amount NUMERIC,
  credit_applied_oc_id UUID REFERENCES dropship_purchase_orders(id),
  credit_applied_at TIMESTAMPTZ,
  credit_strategy TEXT CHECK (credit_strategy IN (
    'same_oc_unpaid', 'same_oc_approved_unpaid',
    'next_oc_credit', 'pending_dispute'
  )),
  marketplace_return_status TEXT,
  marketplace_refund_amount NUMERIC,
  marketplace_refunded_at TIMESTAMPTZ,
  evidence_urls TEXT[] DEFAULT '{}',
  evidence_storage_paths TEXT[] DEFAULT '{}',
  buyer_complaint TEXT,
  internal_notes TEXT,
  partner_response TEXT,
  resolution_notes TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  marketplace_opened_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_returns_org ON dropship_returns(organization_id);
CREATE INDEX idx_returns_supplier ON dropship_returns(supplier_id);
CREATE INDEX idx_returns_status ON dropship_returns(status);
CREATE INDEX idx_returns_credit_pending ON dropship_returns(status)
  WHERE status IN ('credit_pending', 'approved');
CREATE UNIQUE INDEX idx_returns_external ON dropship_returns(marketplace, external_id)
  WHERE external_id IS NOT NULL;

-- Créditos do parceiro (saldo a abater)
CREATE TABLE dropship_partner_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  return_id UUID REFERENCES dropship_returns(id),
  manual_adjustment BOOLEAN DEFAULT false,
  source_oc_id UUID REFERENCES dropship_purchase_orders(id),
  credit_amount NUMERIC NOT NULL,
  credit_type TEXT NOT NULL CHECK (credit_type IN (
    'return', 'cancellation', 'warranty', 'divergence',
    'manual_adjustment', 'negotiated_discount', 'previous_payment'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'applied', 'partially_applied', 'cancelled', 'expired'
  )),
  applied_to_oc_id UUID REFERENCES dropship_purchase_orders(id),
  applied_amount NUMERIC,
  remaining_amount NUMERIC GENERATED ALWAYS AS (
    credit_amount - COALESCE(applied_amount, 0)
  ) STORED,
  applied_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credits_supplier ON dropship_partner_credits(supplier_id);
CREATE INDEX idx_credits_status ON dropship_partner_credits(status);
CREATE INDEX idx_credits_pending ON dropship_partner_credits(supplier_id, status)
  WHERE status = 'pending';

-- Disputas
CREATE TABLE dropship_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  return_id UUID REFERENCES dropship_returns(id),
  oc_item_id UUID REFERENCES dropship_purchase_order_items(id),
  dispute_type TEXT NOT NULL CHECK (dispute_type IN (
    'cost_divergence', 'responsibility', 'amount',
    'product_returned', 'item_inclusion', 'other'
  )),
  claimed_by TEXT NOT NULL CHECK (claimed_by IN ('seller', 'partner')),
  claimed_by_name TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount_claimed NUMERIC,
  amount_partner_accepts NUMERIC,
  amount_seller_proposes NUMERIC,
  final_resolved_amount NUMERIC,
  reason TEXT NOT NULL,
  description TEXT,
  evidence_urls TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'in_review', 'mediation', 'resolved_partner',
    'resolved_seller', 'resolved_compromise', 'escalated', 'closed'
  )),
  resolution TEXT,
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_disputes_supplier ON dropship_disputes(supplier_id);
CREATE INDEX idx_disputes_status ON dropship_disputes(status)
  WHERE status NOT IN ('closed', 'resolved_partner', 'resolved_seller', 'resolved_compromise');

-- GRANTs
GRANT ALL ON TABLE public.dropship_returns TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dropship_returns TO authenticated;
GRANT ALL ON TABLE public.dropship_partner_credits TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dropship_partner_credits TO authenticated;
GRANT ALL ON TABLE public.dropship_disputes TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dropship_disputes TO authenticated;
```

### Régua de Crédito (4 Cenários)

| Cenário | Quando | Ação |
|---|---|---|
| `same_oc_unpaid` | OC ainda em `draft`/`preview_locked` ou item ainda não em OC | Marca item `excluded`, recalcula totais |
| `same_oc_approved_unpaid` | OC `approved`/`sent`/`viewed` mas não paga | Marca item `credited`, gera crédito DENTRO da OC, ajusta `net_total` |
| `next_oc_credit` | OC `paid`/`partially_paid` | Cria `dropship_partner_credits` com status `pending` para próxima OC |
| `pending_dispute` | Em disputa | Mantém `status = disputed`, sem crédito até resolução |

---

## CAMADA D4 — IA + Score + Auditoria

### Objetivo

Score do parceiro (0-100), copiloto Dropship, detecção automática de divergências, alertas proativos.

### Migration `20260513_dropship_intelligence.sql`

```sql
-- Histórico de score
CREATE TABLE dropship_partner_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_score INTEGER NOT NULL CHECK (total_score >= 0 AND total_score <= 100),
  score_breakdown JSONB NOT NULL,
  raw_metrics JSONB NOT NULL,
  insights JSONB DEFAULT '[]',
  prev_score INTEGER,
  score_change INTEGER,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_partner_scores_supplier ON dropship_partner_scores(supplier_id);
CREATE INDEX idx_partner_scores_period ON dropship_partner_scores(period_end DESC);

-- Divergências detectadas
CREATE TABLE dropship_divergences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  divergence_type TEXT NOT NULL CHECK (divergence_type IN (
    'cost_change_uninformed', 'cost_at_oc_different', 'stock_inconsistency',
    'shipment_delay', 'no_shipment_confirmation', 'return_amount_mismatch',
    'duplicate_oc_item', 'missing_partner_product', 'price_below_cost'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  identification_id UUID REFERENCES dropship_order_identifications(id),
  supplier_product_id UUID REFERENCES supplier_products(id),
  oc_id UUID REFERENCES dropship_purchase_orders(id),
  oc_item_id UUID REFERENCES dropship_purchase_order_items(id),
  expected_value NUMERIC,
  actual_value NUMERIC,
  difference_amount NUMERIC,
  difference_pct NUMERIC,
  description TEXT NOT NULL,
  context JSONB DEFAULT '{}',
  recommended_action TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'acknowledged', 'investigating', 'resolved', 'ignored'
  )),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id),
  resolution_notes TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_divergences_org ON dropship_divergences(organization_id);
CREATE INDEX idx_divergences_supplier ON dropship_divergences(supplier_id);
CREATE INDEX idx_divergences_status ON dropship_divergences(status)
  WHERE status IN ('open', 'acknowledged', 'investigating');
CREATE INDEX idx_divergences_severity ON dropship_divergences(severity);

GRANT ALL ON TABLE public.dropship_partner_scores TO service_role;
GRANT SELECT ON TABLE public.dropship_partner_scores TO authenticated;
GRANT ALL ON TABLE public.dropship_divergences TO service_role;
GRANT SELECT, UPDATE ON TABLE public.dropship_divergences TO authenticated;
```

### Score Engine — Dimensões v1 (5 essenciais)

```
stock_accuracy        — estoque informado bate com vendas (0-20 peso ajustado)
ship_lead_compliance  — cumpre prazo de envio (0-20)
divergence_rate       — poucas divergências (0-20)
return_rate           — taxa de devolução baixa (0-20)
approval_speed        — aprova OC rápido (0-20)
```

v2 adiciona: `price_update_speed`, `sac_responsiveness`, `scalability`, `delay_rate_inverse`, `communication`.

### Endpoints D4

```
-- Score --
GET    /dropship/partners/:id/score             → Score atual + breakdown
GET    /dropship/partners/:id/score/history     → Histórico
POST   /dropship/partners/:id/score/recalculate → Forçar recálculo
GET    /dropship/partners/scores                → Ranking

-- Divergências --
GET    /dropship/divergences                    → Listar
GET    /dropship/divergences/:id                → Detalhe
POST   /dropship/divergences/:id/acknowledge    → Marcar visto
POST   /dropship/divergences/:id/resolve        → Resolver
POST   /dropship/divergences/scan               → Forçar scan

-- IA --
POST   /dropship/copilot/message                → Comando ao copiloto
GET    /dropship/copilot/insights/daily         → Insights proativos

-- Auditoria --
GET    /dropship/audit                          → Histórico geral
GET    /dropship/audit/oc/:id                   → Auditoria de OC
```

---

## Resumo Geral

### Tabelas (15 novas + 1 ALTER)

#### `supplier_*` (3 novas + 1 ALTER)
| # | Tabela | Sprint |
|---|---|---|
| - | `suppliers` (existe) | — |
| - | `supplier_products` (existe + ALTER 6 colunas) | 1 |
| 1 | `supplier_dropship_profiles` | 1 |
| 2 | `seller_account_suppliers` | 1 |
| 3 | `supplier_cost_history` | 2 |

#### `dropship_*` (12 novas)
| # | Tabela | Sprint |
|---|---|---|
| 4 | `dropship_sync_logs` | 2 |
| 5 | `dropship_order_identifications` | 3 |
| 6 | `dropship_summary` | 3 |
| 7 | `dropship_purchase_orders` | 4 |
| 8 | `dropship_purchase_order_items` | 4 |
| 9 | `dropship_partner_portal_sessions` | 6 |
| 10 | `dropship_oc_notifications` | 6 |
| 11 | `dropship_returns` | 8 |
| 12 | `dropship_partner_credits` | 9 |
| 13 | `dropship_disputes` | 10 |
| 14 | `dropship_partner_scores` | 11 |
| 15 | `dropship_divergences` | 12 |

### Endpoints Totais: 78

### Estimativa de Custo IA

| Operação | Custo |
|---|---|
| Sync de catálogo | $0.00 |
| Identificação de pedido dropship | $0.00 |
| Detecção de divergência | $0.00 (regras) |
| Geração de score do parceiro (com insights IA) | ~$0.02 |
| Copiloto (1 comando) | ~$0.01 |
| Score mensal de 10 parceiros | ~$0.20 |

### Ordem de Implementação

| Sprint | Camada | Escopo |
|---|---|---|
| 1 | D1 | **Migration base + cadastro de parceiros + vínculo conta-supplier** |
| 2 | D1 | Catálogo + sync (manual + planilha) + cost history |
| 3 | D1 | Identificação de pedidos dropship + dashboard + telas |
| 4 | D2 | Migration OC + geração às 22h + cálculo de totais |
| 5 | D2 | Pré-OC live + cutoff + telas durante o dia |
| 6 | D2 | Portal do parceiro + token + aprovação + envio e-mail/WhatsApp |
| 7 | D2 | Integração com financeiro (contas a pagar) + auditoria |
| 8 | D3 | Migration devoluções + webhooks ML/Shopee + classificação automática |
| 9 | D3 | Régua de 4 cenários + créditos + aplicação na próxima OC |
| 10 | D3 | Disputas + telas + auditoria |
| 11 | D4 | Score engine + breakdown + cron diário |
| 12 | D4 | Detecção de divergências + alertas proativos + copiloto |

### Dependências

**Já existem:**
- `suppliers` table (cadastro genérico — reusado)
- `supplier_products` table (catálogo — estendido com 6 colunas)
- `products` table com `cost_price`, `preferred_supplier_id`, `supply_type`
- `purchase_orders` (importação — não confundir com OC dropship)
- ML/Shopee sync de pedidos
- Motor de margem (Onda 4 A1)
- LlmService multi-provider
- Padrão multi-tenant `organization_id`

**Novas dependências:**
- Webhook público registrado no ML Application (tópico `claims`)
- Webhook Shopee (devoluções)
- Library para gerar PDF (sugestão: `pdfkit` ou `puppeteer`)
- Library XLSX (já tem para outros módulos)
- Library de envio de e-mail (verificar existente) ou SendGrid
- Storage de evidências (Supabase Storage bucket `dropship-evidence`)

---

## Padrões e-Click obrigatórios (aplicar em TODOS os sprints)

1. **Multi-tenant:** toda query Supabase filtra `organization_id`. Toda UNIQUE inclui `organization_id`. Nunca hardcode UUID Vazzo.
2. **GRANTs explícitos:** todo `CREATE TABLE` termina com `GRANT ALL ... TO service_role` + `GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated` (gotcha §11.J).
3. **Linguagem PT-BR:** comentários, mensagens de erro, copy de UI. Erros amigáveis em `BadRequestException`.
4. **IA aplicada:** Score + Copiloto usam `LlmService.generateText({orgId, feature, ...})`. Criar nova `feature_key` em `ai_feature_settings` por uso.
5. **Cron com nome:** `@Cron('0 22 * * *', { name: 'dropship-oc-generation' })` para observabilidade.
6. **Webhook idempotência:** UNIQUE em `(marketplace, external_id)` para evitar reprocessamento.
7. **Copilot KB:** toda sprint que cria/modifica feature visível DEVE atualizar `src/modules/copilot/copilot.kb.ts` no MESMO commit.
8. **Responsividade:** todas as telas funcionam em mobile/tablet/desktop.
9. **Tema claro/escuro:** usar CSS vars (`var(--surface)`, etc.) em vez de hardcodes.
10. **Tags/badges:** estilo pílulas coloridas (rounded-full, border+bg+text mesma cor).

---

## Pontos Críticos para Implementação

### 1. Custo vigente vs histórico

A decisão Vazzo é usar `current_table` por padrão. O sistema usa `supplier_products.unit_cost` no momento da geração da OC. O `supplier_cost_history` (Sprint 2) serve **apenas para auditoria histórica**, não para cálculo da OC.

### 2. Cutoff e janela de revisão

Prévia abre 12:00, fecha 21:00. Geração 22:00. Após 21:00, prévia fica `preview_locked` — apenas admin pode alterar.

### 3. Portal do parceiro sem login

URL com token de 32+ chars random. Token expira em **72h**. Cada acesso registrado (IP, user-agent). Rate-limit: 100 req/min por token.

### 4. Webhook ML para devoluções

Tópico `claims`. Resposta < 500ms. Processamento async via fila ou cron. Idempotência via UNIQUE `(marketplace, external_id)`.

### 5. Régua de crédito é a feature mais complexa

4 cenários, cada um com lógica própria. Erros aqui geram disputa. Sprint 9 inteira dedicada — incluir testes unitários extensivos antes de UI.

### 6. Score do parceiro

Calculado mensalmente via cron. v1 começa com 5 dimensões (stock_accuracy, ship_lead_compliance, divergence_rate, return_rate, approval_speed). v2 adiciona resto. Score informativo na v1; v2 pode virar gating.
