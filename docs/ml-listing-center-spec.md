# ML Listing Center IA — Especificação Técnica

**Módulo F10 do e-Click SaaS** (eclick.app.br)
**Versão:** 1.1 (pós-smoke-test 2026-05-10)
**Stack:** Next.js (Netlify) + NestJS (Railway) + Supabase Postgres

**Pré-requisitos (módulos já entregues):**
- F7 ML Quality Center IA → fornece sinais de qualidade
- F8 ML Campaign Center IA → fornece sinais de campanha
- F9 Dropship Center IA → fornece sinais de estoque/parceiro
- ML API client (já existe)
- Padrão multi-tenant `seller_id` (`feedback_ml_multiconta_token`)

**Encaixe no roadmap:** após F8 estabilizar (consome dados dele).

---

## Visão do Módulo

Central única de tarefas e ações recomendadas para anúncios Mercado Livre. **Não duplica lógica** dos outros módulos — agrega via VIEW SQL os sinais já gerados pelo F7, F8 e F9, e adiciona scanners próprios para o que é exclusivo (preço, automação, fiscal, política).

### Princípio Central

**Uma tela só, todas as ações priorizadas.** Lojista entra, vê o que fazer hoje, executa em massa.

### Arquitetura híbrida

```
┌──────────────────────────────────────────────────────┐
│           ML LISTING CENTER (F10)                    │
│           Tabela: ml_listing_tasks                   │
└────────────────┬─────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
   ┌────▼────┐      ┌─────▼─────┐
   │ VIEW SQL│      │ SCANNERS  │
   │agregadora│      │ próprios  │
   └────┬────┘      └─────┬─────┘
        │                 │
   ┌────┴───────┐    ┌────┴──────────────────┐
   ▼            ▼    ▼                       ▼
F7 Quality  F8 Campaign  pricing (price_to_win)  fiscal, política
F9 Dropship              automation              dimensões
```

---

## Cortes do MVP v1 (8 cards)

| Card | Origem | Notas |
|------|--------|-------|
| Sem estoque | Scanner próprio | |
| Pausados/Inativos | Scanner próprio (genérico v1, política em v1.1) | |
| Qualidade baixa | Agregado F7 | |
| Preço alto | Scanner novo (`price_to_win`) | Inclui razão "perdendo Buy Box" |
| Automação disponível | Scanner novo (`pricing-automation`) | |
| Dados fiscais incompletos | Scanner novo | |
| Promoção disponível | Agregado F8 | |
| **Catálogo / Buy Box elegível** | **Cross-check `/products/{catalog_id}/items` × competidores** | **Promovido de v1.1 → v1** porque `catalog_product_id` vem de graça do `price_to_win` |

### Cards adiados para v1.1+

- Dimensões incorretas (regra de comparação com peso real)
- Mudança no custo de envio (cruzamento de `listing_prices` histórico)
- Problemas de experiência (cruzamento orders + claims + returns + messages)
- Elegível para Full (regras semi-públicas)

---

## Sprint 0 — Smoke Test (FEITO 2026-05-10)

Validação obrigatória dos endpoints novos antes de migrations. Resultados:

| Endpoint | Status | Notas |
|---|---|---|
| `GET /suggestions/user/{seller}/items` | ✅ 200 | Retorna **só lista de IDs** com sugestão. Vazzo: 140 itens. |
| `GET /suggestions/items/{id}` | ❌ 404 sempre | **NÃO EXISTE.** Spec original assumia errado. Substituído por `price_to_win` abaixo. |
| `GET /items/{id}/price_to_win` | ✅ 200 | **Endpoint canônico para sugestão de preço.** Mais rico que o original — ver shape abaixo. |
| `GET /pricing-automation/items/{id}/rules` | ✅ 200 | Retorna `{item_id, rules: [{rule_id: 'INT'\|'INT_EXT'}]}` |
| `GET /pricing-automation/items/{id}/automation` | ✅ 200 (se automatizado) / 404 (se não) | Shape: `{status, item_rule, min_price, max_price, status_detail: {cause, message}}` |
| `GET /pricing-automation/users/{seller}/items` | ✅ 200 | Lista IDs automatizados. Vazzo: 1 item. |

### Shape do `/items/{id}/price_to_win` (canônico)

```json
{
  "item_id": "MLB5406302054",
  "current_price": 194,
  "currency_id": "BRL",
  "price_to_win": 194,
  "status": "winning",                    // winning | losing | sharing_first_place
  "consistent": true,
  "visit_share": "maximum",                // maximum | medium | low
  "competitors_sharing_first_place": 0,
  "boosts": {
    "free_shipping": true,
    "fulfillment": false,
    "cross_docking": true,
    "same_day_shipping": true,
    "drop_off": false,
    "free_installments": false
  },
  "reason": [],                            // motivos de estar perdendo
  "catalog_product_id": "MLB19774609",
  "winner": { "item_id": "...", "price": 194 }
}
```

### Shape do `/pricing-automation/items/{id}/automation`

```json
{
  "item_id": "MLB4098863817",
  "status": "PAUSED",                      // ACTIVE | PAUSED
  "item_rule": { "rule_id": "INT" },
  "min_price": 195,
  "max_price": 280,
  "status_detail": {
    "cause": "PROMO",
    "message": "We will adjust your price once the promotion ends on 11/05"
  }
}
```

Scripts de smoke test estão em `scripts/smoke-test-pricing-endpoints.mjs` e `scripts/smoke-test-suggestions-variants.mjs` (rastreável em git pra próximas sessões).

---

## Entregas em 4 Camadas

| # | Nome | Escopo | Sprints |
|---|------|--------|---------|
| L1 | Foundation + Agregação | Schema central + VIEW dos módulos + Sem estoque + Pausados | 2 |
| L2 | Pricing Intelligence | Sugestões via `price_to_win` + Automação ML + Catálogo/Buy Box | 2 |
| L3 | Fiscal + Política | Dados fiscais + Política/Pausados refinado | 2 |
| L4 | IA + Score + Bulk | Score por anúncio + Copiloto + Ações em massa + LOSING_BUY_BOX | 2 |

---

## CAMADA L1 — Foundation + Agregação

### Tabelas

```sql
-- ============================================================
-- Migration: 20260515_listing_center_foundation.sql
-- Schema: public (SaaS)
-- ============================================================

-- 1. Tabela central de tarefas
CREATE TABLE ml_listing_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  ml_user_product_id TEXT,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,

  task_type TEXT NOT NULL CHECK (task_type IN (
    -- v1
    'OUT_OF_STOCK',
    'INACTIVE_PAUSED',
    'QUALITY_LOW',
    'QUALITY_INCOMPLETE',
    'PRICE_HIGH',
    'PRICE_AUTOMATION_AVAILABLE',
    'FISCAL_DATA_MISSING',
    'PROMOTION_AVAILABLE',
    'PROMOTION_HIGH_OPPORTUNITY',
    'DROPSHIP_PARTNER_OUT_OF_STOCK',
    'CATALOG_ELIGIBLE',                    -- promovido de v1.1 → v1
    'LOSING_BUY_BOX',                      -- novo (descoberto via price_to_win)
    -- v1.1+
    'INACTIVE_BY_POLICY',
    'WRONG_DIMENSIONS',
    'SHIPPING_COST_CHANGED',
    'BUYER_EXPERIENCE_ISSUE',
    'FULL_ELIGIBLE'
  )),
  task_title TEXT NOT NULL,
  task_description TEXT,

  source TEXT NOT NULL CHECK (source IN (
    'aggregated_quality',
    'aggregated_campaign',
    'aggregated_dropship',
    'scanner_stock',
    'scanner_status',
    'scanner_pricing',
    'scanner_automation',
    'scanner_catalog',                     -- novo: cross-check Buy Box
    'scanner_fiscal',
    'scanner_dimensions',
    'scanner_shipping',
    'scanner_experience',
    'manual'
  )),

  source_record_id UUID,
  source_table TEXT,

  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  priority_score INTEGER CHECK (priority_score >= 0 AND priority_score <= 100),

  impact_area TEXT[] DEFAULT '{}',
  estimated_impact_brl NUMERIC,
  estimated_impact_description TEXT,

  current_value JSONB DEFAULT '{}',
  suggested_value JSONB DEFAULT '{}',
  suggested_action TEXT,

  deeplink_url TEXT,
  deeplink_module TEXT,

  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'snoozed', 'in_progress',
    'resolved_auto', 'resolved_manual', 'dismissed', 'expired'
  )),
  snoozed_until TIMESTAMPTZ,
  resolution_notes TEXT,
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,

  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detection_count INTEGER DEFAULT 1,

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_listing_tasks_org_seller ON ml_listing_tasks(organization_id, seller_id);
CREATE INDEX idx_listing_tasks_item ON ml_listing_tasks(ml_item_id);
CREATE INDEX idx_listing_tasks_product ON ml_listing_tasks(product_id);
CREATE INDEX idx_listing_tasks_type ON ml_listing_tasks(task_type);
CREATE INDEX idx_listing_tasks_status ON ml_listing_tasks(status)
  WHERE status IN ('open', 'snoozed', 'in_progress');
CREATE INDEX idx_listing_tasks_priority ON ml_listing_tasks(priority_score DESC)
  WHERE status = 'open';
CREATE INDEX idx_listing_tasks_severity ON ml_listing_tasks(severity)
  WHERE status = 'open';

-- 1 tarefa ativa do mesmo tipo por item (idempotência)
CREATE UNIQUE INDEX idx_listing_tasks_unique_active
  ON ml_listing_tasks(organization_id, seller_id, ml_item_id, task_type)
  WHERE status IN ('open', 'snoozed', 'in_progress');

-- IMPORTANTE pós-migration: GRANTs explícitos (gotcha _admin_exec_sql)
GRANT ALL ON ml_listing_tasks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ml_listing_tasks TO authenticated;
```

```sql
-- 2. Logs de scan
CREATE TABLE ml_listing_scan_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  seller_id BIGINT,
  scan_type TEXT NOT NULL CHECK (scan_type IN (
    'full', 'aggregation_only',
    'scanner_stock', 'scanner_status',
    'scanner_pricing', 'scanner_automation', 'scanner_catalog',
    'scanner_fiscal', 'scanner_dimensions',
    'scanner_shipping', 'scanner_experience'
  )),
  items_scanned INTEGER DEFAULT 0,
  tasks_created INTEGER DEFAULT 0,
  tasks_updated INTEGER DEFAULT 0,
  tasks_resolved_auto INTEGER DEFAULT 0,
  api_calls_count INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  error_details JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  duration_seconds INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_listing_scan_logs_org_seller ON ml_listing_scan_logs(organization_id, seller_id);
CREATE INDEX idx_listing_scan_logs_status ON ml_listing_scan_logs(status);

GRANT ALL ON ml_listing_scan_logs TO service_role;
GRANT SELECT, INSERT, UPDATE ON ml_listing_scan_logs TO authenticated;
```

```sql
-- 3. Resumo agregado (dashboard)
CREATE TABLE ml_listing_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  seller_id BIGINT NOT NULL,
  total_open_tasks INTEGER DEFAULT 0,
  total_critical INTEGER DEFAULT 0,
  total_high INTEGER DEFAULT 0,
  total_medium INTEGER DEFAULT 0,
  total_low INTEGER DEFAULT 0,
  tasks_by_type JSONB DEFAULT '{}',
  total_estimated_impact_brl NUMERIC DEFAULT 0,
  high_impact_tasks_count INTEGER DEFAULT 0,
  avg_resolution_hours NUMERIC,
  tasks_resolved_30d INTEGER DEFAULT 0,
  tasks_created_30d INTEGER DEFAULT 0,
  last_full_scan_at TIMESTAMPTZ,
  next_scan_scheduled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_listing_summary_unique ON ml_listing_summary(organization_id, seller_id);

GRANT ALL ON ml_listing_summary TO service_role;
GRANT SELECT ON ml_listing_summary TO authenticated;
```

```sql
-- 4. VIEW agregadora (sem duplicar dados)
CREATE OR REPLACE VIEW v_listing_aggregated_signals AS
-- Sinais do F7 Quality Center
SELECT
  qs.organization_id,
  qs.seller_id,
  qs.ml_item_id,
  qs.product_id,
  'aggregated_quality' AS source,
  qs.id AS source_record_id,
  'ml_quality_snapshots' AS source_table,
  CASE
    WHEN qs.ml_score < 50 THEN 'QUALITY_LOW'
    WHEN qs.pending_count > 0 THEN 'QUALITY_INCOMPLETE'
    ELSE NULL
  END AS task_type,
  CASE
    WHEN qs.ml_score < 30 THEN 'critical'
    WHEN qs.ml_score < 50 THEN 'high'
    WHEN qs.ml_score < 70 THEN 'medium'
    ELSE 'low'
  END AS severity,
  qs.ml_score AS quality_score,
  qs.pending_count AS missing_attrs_count,
  qs.has_exposure_penalty,
  qs.fetched_at AS source_updated_at
FROM ml_quality_snapshots qs
WHERE qs.ml_score < 70 OR qs.has_exposure_penalty = true OR qs.pending_count > 0

UNION ALL

-- Sinais do F8 Campaign Center
SELECT
  cr.organization_id,
  cr.seller_id,
  ci.ml_item_id,
  cr.product_id,
  'aggregated_campaign' AS source,
  cr.id AS source_record_id,
  'ml_campaign_recommendations' AS source_table,
  CASE
    WHEN cr.recommendation = 'recommended' AND cr.opportunity_score >= 80 THEN 'PROMOTION_HIGH_OPPORTUNITY'
    WHEN cr.recommendation IN ('recommended', 'recommended_caution') THEN 'PROMOTION_AVAILABLE'
    ELSE NULL
  END AS task_type,
  CASE
    WHEN cr.opportunity_score >= 90 THEN 'high'
    WHEN cr.opportunity_score >= 75 THEN 'medium'
    ELSE 'low'
  END AS severity,
  NULL AS quality_score,
  NULL AS missing_attrs_count,
  false AS has_exposure_penalty,
  cr.created_at AS source_updated_at
FROM ml_campaign_recommendations cr
JOIN ml_campaign_items ci ON ci.id = cr.campaign_item_id
WHERE cr.status = 'pending' AND cr.recommendation IN ('recommended', 'recommended_caution')

UNION ALL

-- Sinais do F9 Dropship Center
-- ATENÇÃO: seller_id em supplier_products NÃO existe direto.
-- Resolver via seller_account_suppliers (que mapeia marketplace+seller_id → supplier_id por org).
SELECT
  sas.organization_id,
  sas.seller_id,
  pl.listing_id AS ml_item_id,
  sp.product_id,
  'aggregated_dropship' AS source,
  sp.id AS source_record_id,
  'supplier_products' AS source_table,
  'DROPSHIP_PARTNER_OUT_OF_STOCK' AS task_type,
  CASE
    WHEN sp.partner_available <= 0 THEN 'critical'
    WHEN sp.partner_available <= 3 THEN 'high'
    ELSE 'medium'
  END AS severity,
  NULL AS quality_score,
  NULL AS missing_attrs_count,
  false AS has_exposure_penalty,
  sp.last_stock_change_at AS source_updated_at
FROM supplier_products sp
JOIN seller_account_suppliers sas
  ON sas.supplier_id = sp.supplier_id
 AND sas.organization_id = sp.organization_id
 AND sas.active_until IS NULL
 AND sas.marketplace = 'mercado_livre'
JOIN product_listings pl
  ON pl.product_id = sp.product_id
 AND pl.platform = 'mercadolivre'
 AND pl.is_active = true
WHERE sp.partner_available <= 3;
```

### Endpoints L1

```
-- Dashboard --
GET    /listings                       → Dashboard executivo
GET    /listings/summary               → Resumo agregado
GET    /listings/tasks/by-type         → Contagem por tipo
GET    /listings/tasks/critical        → Tarefas críticas

-- Tarefas --
GET    /listings/tasks                 → Listar (filtros: type, severity, item, product)
GET    /listings/tasks/:id             → Detalhe
PATCH  /listings/tasks/:id             → Atualizar status (snooze, dismiss)
POST   /listings/tasks/:id/resolve     → Marcar como resolvida manualmente
POST   /listings/tasks/:id/snooze      → Adiar por N dias
POST   /listings/tasks/:id/dismiss     → Descartar com motivo

-- Por anúncio --
GET    /listings/items/:itemId         → Todas as tarefas de 1 anúncio
GET    /listings/items/:itemId/health  → Score consolidado do anúncio

-- Scan --
POST   /listings/scan/full             → Rodar full scan
POST   /listings/scan/:scannerType     → Rodar scanner específico
GET    /listings/scan/logs             → Histórico de scans

-- L1 específicos --
POST   /listings/scan/stock            → Scanner de estoque
POST   /listings/scan/status           → Scanner de status pausado
GET    /listings/out-of-stock          → Anúncios sem estoque
GET    /listings/inactive              → Anúncios pausados
```

### Aggregation Service

```typescript
// listing-aggregation.service.ts
class ListingAggregationService {
  async aggregateSignals(orgId: string, sellerId: number): Promise<AggregationResult> {
    const signals = await this.db.query(`
      SELECT * FROM v_listing_aggregated_signals
      WHERE organization_id = $1 AND seller_id = $2 AND task_type IS NOT NULL
    `, [orgId, sellerId])

    let created = 0, updated = 0
    for (const signal of signals) {
      const existing = await this.taskRepo.findActiveBy({
        organization_id: orgId,
        seller_id: sellerId,
        ml_item_id: signal.ml_item_id,
        task_type: signal.task_type,
      })
      if (existing) {
        await this.taskRepo.update(existing.id, {
          last_seen_at: new Date(),
          detection_count: existing.detection_count + 1,
          severity: signal.severity,
          source_record_id: signal.source_record_id,
          updated_at: new Date(),
        })
        updated++
      } else {
        await this.createTaskFromSignal(signal)
        created++
      }
    }

    // Auto-resolver tarefas que não apareceram mais (sinal sumiu)
    await this.autoResolveStaleAggregated(orgId, sellerId)
    return { created, updated }
  }

  private async autoResolveStaleAggregated(orgId: string, sellerId: number) {
    const staleHours = 6
    return this.db.query(`
      UPDATE ml_listing_tasks
      SET status = 'resolved_auto', resolved_at = now(),
          resolution_notes = 'Sinal não detectado mais (auto-resolvido)'
      WHERE organization_id = $1 AND seller_id = $2
        AND source LIKE 'aggregated_%' AND status = 'open'
        AND last_seen_at < now() - interval '${staleHours} hours'
    `, [orgId, sellerId])
  }
}
```

### Stock Scanner

```typescript
class ListingStockScanner {
  async scan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.createScanLog(orgId, sellerId, 'scanner_stock')
    try {
      // SEMPRE passar sellerId no getTokenForOrg (gotcha multi-conta)
      const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
      const items = await this.mlClient.searchItems(token, sellerId, { status: 'active' })

      let outOfStockCount = 0
      for (const item of items) {
        const fullItem = await this.mlClient.getItem(token, item.id)
        if (fullItem.available_quantity === 0) {
          await this.taskRepo.upsertActiveTask({
            organization_id: orgId,
            seller_id: sellerId,
            ml_item_id: fullItem.id,
            task_type: 'OUT_OF_STOCK',
            task_title: 'Anúncio sem estoque',
            task_description: `Disponível: 0. Última venda: ${this.formatDate(fullItem.last_updated)}`,
            source: 'scanner_stock',
            severity: this.computeSeverity(fullItem),
            priority_score: this.computePriority(fullItem),
            impact_area: ['sales', 'reputation'],
            current_value: { stock: 0 },
            suggested_value: { stock: this.suggestRestock(fullItem) },
            suggested_action: 'Repor estoque ou pausar anúncio',
            estimated_impact_brl: this.estimateImpact(fullItem),
          })
          outOfStockCount++
        }
      }

      await this.autoResolveResolved(orgId, sellerId)  // estoque voltou
      await this.completeScanLog(log.id, { items_scanned: items.length, tasks_created: outOfStockCount })
      return { success: true, out_of_stock: outOfStockCount }
    } catch (error) {
      await this.failScanLog(log.id, error)
      throw error
    }
  }
}
```

---

## CAMADA L2 — Pricing Intelligence

**Atualizado pós-smoke-test:** o endpoint `/suggestions/items/{id}` da spec original NÃO EXISTE. Substituído por `/items/{id}/price_to_win` que entrega dados muito mais ricos.

### Tabelas

```sql
-- ============================================================
-- Migration: 20260516_listing_pricing_intelligence.sql
-- ============================================================

-- 1. Cache de sugestões de preço por item (via price_to_win)
CREATE TABLE ml_listing_pricing_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  product_id UUID REFERENCES products(id),

  -- Preço atual vs sugerido (price_to_win)
  current_price NUMERIC NOT NULL,
  suggested_price NUMERIC NOT NULL,         -- = price_to_win
  price_difference_brl NUMERIC GENERATED ALWAYS AS (current_price - suggested_price) STORED,
  price_difference_pct NUMERIC GENERATED ALWAYS AS (
    CASE WHEN current_price > 0 THEN ((current_price - suggested_price) / current_price) * 100 ELSE 0 END
  ) STORED,

  -- Status competitivo (do price_to_win)
  buy_box_status TEXT CHECK (buy_box_status IN ('winning', 'losing', 'sharing_first_place')),
  visit_share TEXT CHECK (visit_share IN ('maximum', 'medium', 'low')),
  competitors_sharing INTEGER DEFAULT 0,
  consistent BOOLEAN DEFAULT true,
  reason TEXT[] DEFAULT '{}',               -- motivos de não estar ganhando

  -- Catálogo / vencedor atual
  catalog_product_id TEXT,                  -- desbloqueia card CATALOG_ELIGIBLE
  winner_item_id TEXT,                      -- quem está vencendo agora
  winner_price NUMERIC,                     -- por quanto

  -- Boosts ativos (alimentam outros scanners — Full, frete grátis, etc.)
  boosts JSONB DEFAULT '{}',
  -- {"free_shipping":true,"fulfillment":false,"cross_docking":true,"same_day_shipping":true,"drop_off":false,"free_installments":false}

  -- Validações internas (com nosso custo)
  internal_margin_at_suggested_pct NUMERIC,
  is_below_min_margin BOOLEAN DEFAULT false,
  is_below_cost BOOLEAN DEFAULT false,

  -- Raw response para debug / auditoria
  raw_response JSONB,

  -- Cache control
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pricing_sugg_org_seller ON ml_listing_pricing_suggestions(organization_id, seller_id);
CREATE INDEX idx_pricing_sugg_item ON ml_listing_pricing_suggestions(ml_item_id);
CREATE INDEX idx_pricing_sugg_diff ON ml_listing_pricing_suggestions(price_difference_pct DESC);
CREATE INDEX idx_pricing_sugg_expires ON ml_listing_pricing_suggestions(expires_at);
CREATE INDEX idx_pricing_sugg_buybox ON ml_listing_pricing_suggestions(buy_box_status)
  WHERE buy_box_status IN ('losing', 'sharing_first_place');
CREATE INDEX idx_pricing_sugg_catalog ON ml_listing_pricing_suggestions(catalog_product_id)
  WHERE catalog_product_id IS NOT NULL;
CREATE UNIQUE INDEX idx_pricing_sugg_unique
  ON ml_listing_pricing_suggestions(organization_id, seller_id, ml_item_id);

GRANT ALL ON ml_listing_pricing_suggestions TO service_role;
GRANT SELECT ON ml_listing_pricing_suggestions TO authenticated;

-- 2. Status de automação de preço por item
CREATE TABLE ml_listing_pricing_automation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  product_id UUID REFERENCES products(id),

  -- Regras disponíveis (do /rules)
  available_rules JSONB DEFAULT '[]',
  -- [{"rule_id":"INT"},{"rule_id":"INT_EXT"}]

  -- Automação ativa (do /automation)
  is_automated BOOLEAN DEFAULT false,
  active_rule TEXT,                          -- INT, INT_EXT
  automation_status TEXT CHECK (automation_status IN ('ACTIVE', 'PAUSED', NULL)),
  pause_cause TEXT,                          -- status_detail.cause
  pause_message TEXT,                        -- status_detail.message

  -- Configuração da automação
  min_price NUMERIC,
  max_price NUMERIC,

  -- Recomendação interna
  internal_recommendation TEXT CHECK (internal_recommendation IN (
    'activate', 'configure_limits', 'review_pause', 'unpause',
    'no_action', 'consider_disable'
  )),
  recommendation_reason TEXT,

  -- IMPORTANTE: a partir de 18/03/2026 ML bloqueia edição de preço
  -- via API quando automação está ativa (status=ACTIVE)
  blocks_manual_edit BOOLEAN DEFAULT false,

  raw_rules_response JSONB,
  raw_automation_response JSONB,

  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '12 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pricing_auto_org_seller ON ml_listing_pricing_automation(organization_id, seller_id);
CREATE INDEX idx_pricing_auto_item ON ml_listing_pricing_automation(ml_item_id);
CREATE INDEX idx_pricing_auto_active ON ml_listing_pricing_automation(is_automated)
  WHERE is_automated = true;
CREATE UNIQUE INDEX idx_pricing_auto_unique
  ON ml_listing_pricing_automation(organization_id, seller_id, ml_item_id);

GRANT ALL ON ml_listing_pricing_automation TO service_role;
GRANT SELECT ON ml_listing_pricing_automation TO authenticated;
```

### Endpoints L2

```
-- Sugestões de preço (via price_to_win) --
POST   /listings/scan/pricing                   → Scanner 2-step (lista → price_to_win por item)
GET    /listings/pricing/suggestions            → Listar (filtros: buy_box_status, diff%)
GET    /listings/pricing/suggestions/:itemId    → Detalhe + simulador
POST   /listings/pricing/apply/:itemId          → Aplicar preço sugerido
POST   /listings/pricing/apply-batch            → Aplicar em lote (com validação margem)

-- Catálogo / Buy Box (novo em v1) --
POST   /listings/scan/catalog                   → Cross-check com /products/{catalog_id}/items
GET    /listings/catalog/eligible               → Itens com catalog_product_id mas perdendo BB

-- Automação --
POST   /listings/scan/automation                → Roda scanner de automação
GET    /listings/pricing/automation             → Status de automação por item
GET    /listings/pricing/automation/eligible    → Itens elegíveis (regras disponíveis, não automatizados)
GET    /listings/pricing/automation/active      → Itens com automação ativa (bloqueiam edit manual)
POST   /listings/pricing/automation/:itemId/activate
POST   /listings/pricing/automation/:itemId/pause
POST   /listings/pricing/automation/:itemId/configure
POST   /listings/pricing/automation/:itemId/disable
```

### Pricing Suggestion Scanner (2-step pós-smoke-test)

```typescript
// listing-pricing-scanner.service.ts
class ListingPricingScanner {
  async scanSuggestions(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.createScanLog(orgId, sellerId, 'scanner_pricing')
    try {
      const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

      // STEP 1: lista de IDs com sugestão (1 chamada)
      const listResp = await this.mlClient.get(token,
        `/suggestions/user/${sellerId}/items`)
      const itemsWithSuggestions: string[] = listResp.items ?? []

      let count = 0, losingBuyBoxCount = 0
      // STEP 2: pra cada ID, hit /items/{id}/price_to_win (N chamadas)
      // Pacing 200ms entre calls = 5 req/s, consistente com shipping-enrich
      for (const itemId of itemsWithSuggestions) {
        const ptw = await this.mlClient.get(token, `/items/${itemId}/price_to_win`)
        if (!ptw) continue

        const product = await this.productRepo.findByMlItemId(itemId)
        const cost = product?.cost_price || 0
        const marginAtSuggested = this.calculateMargin(ptw.price_to_win, product)
        const isBelowMin = marginAtSuggested < (product?.min_margin_pct || 15)
        const isBelowCost = ptw.price_to_win < cost

        // Salvar em cache (rico — todos os campos de price_to_win)
        await this.suggestionRepo.upsert({
          organization_id: orgId,
          seller_id: sellerId,
          ml_item_id: itemId,
          product_id: product?.id,
          current_price: ptw.current_price,
          suggested_price: ptw.price_to_win,
          buy_box_status: ptw.status,                // winning | losing | sharing_first_place
          visit_share: ptw.visit_share,              // maximum | medium | low
          competitors_sharing: ptw.competitors_sharing_first_place,
          consistent: ptw.consistent,
          reason: ptw.reason ?? [],
          catalog_product_id: ptw.catalog_product_id,
          winner_item_id: ptw.winner?.item_id,
          winner_price: ptw.winner?.price,
          boosts: ptw.boosts ?? {},
          internal_margin_at_suggested_pct: marginAtSuggested,
          is_below_min_margin: isBelowMin,
          is_below_cost: isBelowCost,
          raw_response: ptw,
        })

        const diffPct = ((ptw.current_price - ptw.price_to_win) / ptw.current_price) * 100

        // Tarefa PRICE_HIGH se diferença for relevante (>5%) e não abaixo do custo
        if (diffPct >= 5 && !isBelowCost) {
          await this.taskRepo.upsertActiveTask({
            organization_id: orgId,
            seller_id: sellerId,
            ml_item_id: itemId,
            product_id: product?.id,
            task_type: 'PRICE_HIGH',
            task_title: `Preço ${diffPct.toFixed(1)}% acima do sugerido`,
            task_description: `Atual: R$${ptw.current_price} · Sugerido: R$${ptw.price_to_win}` +
              (ptw.reason?.length ? ` · ${ptw.reason.join(', ')}` : ''),
            source: 'scanner_pricing',
            severity: this.computeSeverity(diffPct, isBelowMin),
            priority_score: this.computePriority(diffPct, ptw),
            impact_area: ['sales', 'exposure'],
            current_value: { price: ptw.current_price, margin_pct: this.calculateMargin(ptw.current_price, product) },
            suggested_value: { price: ptw.price_to_win, margin_pct: marginAtSuggested },
            suggested_action: isBelowMin
              ? 'Avaliar — margem ficaria baixa'
              : `Reduzir preço para R$${ptw.price_to_win}`,
            estimated_impact_brl: this.estimatePriceImpact(ptw, product),
            deeplink_url: `/dashboard/listings/pricing/suggestions/${itemId}`,
            deeplink_module: 'listing_center',
          })
          count++
        }

        // Tarefa LOSING_BUY_BOX (novo, só possível com price_to_win)
        if (ptw.status === 'losing' || ptw.competitors_sharing_first_place > 0) {
          await this.taskRepo.upsertActiveTask({
            organization_id: orgId,
            seller_id: sellerId,
            ml_item_id: itemId,
            product_id: product?.id,
            task_type: 'LOSING_BUY_BOX',
            task_title: ptw.status === 'losing'
              ? `Perdendo Buy Box · concorrente cobra R$${ptw.winner_price}`
              : `Buy Box compartilhada com ${ptw.competitors_sharing_first_place} competidor${ptw.competitors_sharing_first_place > 1 ? 'es' : ''}`,
            task_description: `Reduza para R$${ptw.price_to_win} para ganhar visibilidade` +
              (ptw.reason?.length ? `. Motivos: ${ptw.reason.join(', ')}` : ''),
            source: 'scanner_pricing',
            severity: ptw.status === 'losing' ? 'high' : 'medium',
            priority_score: ptw.visit_share === 'low' ? 85 : 65,
            impact_area: ['exposure', 'sales'],
            current_value: { price: ptw.current_price, status: ptw.status, visit_share: ptw.visit_share },
            suggested_value: { price: ptw.price_to_win, target_status: 'winning' },
            suggested_action: `Reduzir para R$${ptw.price_to_win}` +
              (isBelowMin ? ' (atenção: margem baixa)' : ''),
            estimated_impact_brl: this.estimateBuyBoxImpact(ptw, product),
          })
          losingBuyBoxCount++
        }

        // Pacing
        await new Promise(r => setTimeout(r, 200))
      }

      await this.completeScanLog(log.id, {
        items_scanned: itemsWithSuggestions.length,
        tasks_created: count + losingBuyBoxCount,
        api_calls_count: 1 + itemsWithSuggestions.length,
      })
      return { success: true, suggestions: count, losing_buy_box: losingBuyBoxCount }
    } catch (error) {
      await this.failScanLog(log.id, error)
      throw error
    }
  }
}
```

### Catalog/Buy Box Scanner (novo em v1)

```typescript
// listing-catalog-scanner.service.ts
// Aproveita catalog_product_id que vem do price_to_win — sem call extra
// pro endpoint /suggestions ou tracking separado.
class ListingCatalogScanner {
  async scan(orgId: string, sellerId: number): Promise<ScanResult> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // Pega items que tem catalog_product_id (do cache do scanner pricing)
    const itemsWithCatalog = await this.suggestionRepo.findWhere({
      organization_id: orgId,
      seller_id: sellerId,
      catalog_product_id: { not: null },
    })

    let elegivel = 0
    for (const it of itemsWithCatalog) {
      // Lista competidores no mesmo catálogo
      const competitors = await this.mlClient.get(token,
        `/products/${it.catalog_product_id}/items?status=active&limit=10`)

      const ourPosition = competitors.results?.findIndex(c => c.item_id === it.ml_item_id) ?? -1

      // Se não está nos top-3 do catálogo OU não tem free_shipping mas competidor tem,
      // criar tarefa CATALOG_ELIGIBLE
      const top3 = competitors.results?.slice(0, 3) ?? []
      const competitorsHaveFreeShipping = top3.some(c => c.shipping?.free_shipping)
      const ourHaveFreeShipping = it.boosts?.free_shipping

      if (ourPosition > 2 || (competitorsHaveFreeShipping && !ourHaveFreeShipping)) {
        await this.taskRepo.upsertActiveTask({
          organization_id: orgId,
          seller_id: sellerId,
          ml_item_id: it.ml_item_id,
          task_type: 'CATALOG_ELIGIBLE',
          task_title: `Posição #${ourPosition + 1} no catálogo · pode melhorar`,
          source: 'scanner_catalog',
          severity: ourPosition > 5 ? 'medium' : 'low',
          impact_area: ['exposure'],
          current_value: { position: ourPosition + 1, total_competitors: competitors.results?.length },
          suggested_action: ourPosition > 2
            ? 'Avaliar redução de preço ou ativação de Full'
            : 'Ativar frete grátis se viável',
        })
        elegivel++
      }
    }

    return { success: true, catalog_eligible: elegivel }
  }
}
```

### Pricing Automation Scanner

```typescript
class ListingAutomationScanner {
  async scan(orgId: string, sellerId: number): Promise<ScanResult> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // Itens automatizados (1 call)
    const automatedResp = await this.mlClient.get(token,
      `/pricing-automation/users/${sellerId}/items`)
    const automatedSet = new Set<string>(automatedResp.items ?? [])

    // Items ativos (paginar via /users/{seller}/items/search)
    const allItems = await this.mlClient.searchItems(token, sellerId, { status: 'active' })

    let eligibleCount = 0, activeCount = 0, pausedCount = 0

    for (const item of allItems) {
      // Regras disponíveis (1 call por item — caro, paginar / cache)
      const rulesResp = await this.mlClient.get(token,
        `/pricing-automation/items/${item.id}/rules`)
      const rules = rulesResp?.rules ?? []

      // Status atual (só se o item está na lista de automatizados)
      let automation = null
      if (automatedSet.has(item.id)) {
        const autoResp = await this.mlClient.get(token,
          `/pricing-automation/items/${item.id}/automation`)
        automation = autoResp
      }

      const recommendation = this.determineRecommendation(rules, automation, item)

      await this.automationRepo.upsert({
        organization_id: orgId,
        seller_id: sellerId,
        ml_item_id: item.id,
        available_rules: rules,
        is_automated: !!automation,
        active_rule: automation?.item_rule?.rule_id,
        automation_status: automation?.status,           // ACTIVE | PAUSED
        pause_cause: automation?.status_detail?.cause,
        pause_message: automation?.status_detail?.message,
        min_price: automation?.min_price,
        max_price: automation?.max_price,
        internal_recommendation: recommendation.action,
        recommendation_reason: recommendation.reason,
        blocks_manual_edit: !!automation && automation.status === 'ACTIVE',
        raw_rules_response: rules,
        raw_automation_response: automation,
      })

      if (recommendation.action !== 'no_action') {
        await this.taskRepo.upsertActiveTask({
          organization_id: orgId,
          seller_id: sellerId,
          ml_item_id: item.id,
          task_type: 'PRICE_AUTOMATION_AVAILABLE',
          task_title: this.taskTitleFor(recommendation),
          task_description: recommendation.reason,
          source: 'scanner_automation',
          severity: this.severityFor(recommendation),
          priority_score: this.priorityFor(recommendation, item),
          impact_area: ['sales', 'exposure'],
          suggested_action: this.actionFor(recommendation),
          deeplink_url: `/dashboard/listings/pricing/automation/${item.id}`,
        })
      }

      if (rules.length > 0 && !automation) eligibleCount++
      if (automation?.status === 'ACTIVE') activeCount++
      if (automation?.status === 'PAUSED') pausedCount++

      await new Promise(r => setTimeout(r, 200))  // pacing
    }

    return { eligible: eligibleCount, active: activeCount, paused: pausedCount }
  }
}
```

---

## CAMADA L3 — Fiscal + Política

### Tabelas

```sql
-- Migration: 20260517_listing_fiscal_policy.sql

CREATE TABLE ml_listing_fiscal_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  product_id UUID REFERENCES products(id),

  has_ncm BOOLEAN DEFAULT false,
  ncm_value TEXT,
  has_gtin BOOLEAN DEFAULT false,
  gtin_value TEXT,
  has_origin BOOLEAN DEFAULT false,
  origin_value TEXT,
  has_cest BOOLEAN DEFAULT false,
  cest_value TEXT,
  has_brand BOOLEAN DEFAULT false,
  has_model BOOLEAN DEFAULT false,

  fiscal_completeness_score INTEGER,
  blocks_nfe BOOLEAN DEFAULT false,
  missing_fields TEXT[] DEFAULT '{}',

  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_fiscal_snap_unique
  ON ml_listing_fiscal_snapshots(organization_id, seller_id, ml_item_id);
CREATE INDEX idx_fiscal_snap_blocks ON ml_listing_fiscal_snapshots(blocks_nfe)
  WHERE blocks_nfe = true;

GRANT ALL ON ml_listing_fiscal_snapshots TO service_role;
GRANT SELECT ON ml_listing_fiscal_snapshots TO authenticated;

CREATE TABLE ml_listing_pause_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  ml_status TEXT NOT NULL,
  ml_sub_status TEXT[],
  ml_tags TEXT[],
  ml_warnings JSONB,
  pause_category TEXT CHECK (pause_category IN (
    'out_of_stock', 'paused_by_seller', 'moderation_pending',
    'policy_violation', 'image_problem', 'description_problem',
    'price_problem', 'category_problem', 'restricted_product',
    'incomplete_required_fields', 'unknown'
  )),
  pause_severity TEXT CHECK (pause_severity IN ('critical', 'high', 'medium', 'low')),
  is_self_solvable BOOLEAN DEFAULT false,
  suggested_fix TEXT,
  paused_since TIMESTAMPTZ,
  days_paused INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_pause_class_unique
  ON ml_listing_pause_classifications(organization_id, seller_id, ml_item_id);
CREATE INDEX idx_pause_class_category ON ml_listing_pause_classifications(pause_category);

GRANT ALL ON ml_listing_pause_classifications TO service_role;
GRANT SELECT ON ml_listing_pause_classifications TO authenticated;
```

### Endpoints L3

```
POST   /listings/scan/fiscal               → Scanner fiscal
GET    /listings/fiscal                    → Anúncios com problemas fiscais
GET    /listings/fiscal/blocked-nfe        → Bloqueiam NF-e
POST   /listings/fiscal/:itemId/fix        → Aplicar correção fiscal (PUT no item)

POST   /listings/scan/policy               → Refinar classificação de pausados
GET    /listings/policy/by-category        → Agrupado por motivo
GET    /listings/policy/critical           → Casos críticos (violação)
```

### Fiscal Scanner

```typescript
class ListingFiscalScanner {
  private readonly REQUIRED_FOR_NFE = ['NCM', 'GTIN', 'ORIGIN']

  async scan(orgId: string, sellerId: number): Promise<ScanResult> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    const items = await this.mlClient.searchItems(token, sellerId, { status: 'active' })

    let count = 0
    for (const item of items) {
      const fullItem = await this.mlClient.getItem(token, item.id)
      const fiscal = this.analyzeFiscal(fullItem.attributes ?? [])

      await this.fiscalRepo.upsert({
        organization_id: orgId,
        seller_id: sellerId,
        ml_item_id: item.id,
        ...fiscal,
      })

      if (fiscal.blocks_nfe) {
        await this.taskRepo.upsertActiveTask({
          organization_id: orgId,
          seller_id: sellerId,
          ml_item_id: item.id,
          task_type: 'FISCAL_DATA_MISSING',
          task_title: 'Dados fiscais incompletos',
          task_description: `Falta: ${fiscal.missing_fields.join(', ')}. Bloqueia emissão de NF-e.`,
          source: 'scanner_fiscal',
          severity: 'high',
          priority_score: 75,
          impact_area: ['compliance'],
          suggested_action: `Preencher ${fiscal.missing_fields.join(', ')} no anúncio ou no produto`,
        })
        count++
      }
    }

    return { success: true, fiscal_issues: count }
  }
}
```

---

## CAMADA L4 — IA + Score + Bulk

### Tabelas

```sql
-- Migration: 20260518_listing_intelligence.sql

CREATE TABLE ml_listing_health_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  product_id UUID REFERENCES products(id),

  health_score INTEGER NOT NULL,

  -- Breakdown
  quality_score INTEGER,        -- F7
  pricing_score INTEGER,        -- L2 (inclui Buy Box)
  fiscal_score INTEGER,         -- L3
  status_score INTEGER,         -- L1
  margin_score INTEGER,         -- interno
  sales_score INTEGER,          -- vendas

  key_issues TEXT[] DEFAULT '{}',

  top_recommendation TEXT,
  top_recommendation_impact NUMERIC,

  trend TEXT CHECK (trend IN ('improving', 'stable', 'degrading')),
  prev_score INTEGER,
  score_change INTEGER,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_health_scores_org_seller ON ml_listing_health_scores(organization_id, seller_id);
CREATE INDEX idx_health_scores_item ON ml_listing_health_scores(ml_item_id);
CREATE INDEX idx_health_scores_low ON ml_listing_health_scores(health_score)
  WHERE health_score < 60;

GRANT ALL ON ml_listing_health_scores TO service_role;
GRANT SELECT ON ml_listing_health_scores TO authenticated;

CREATE TABLE ml_listing_bulk_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  seller_id BIGINT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'apply_price_suggestions', 'activate_automation', 'pause_automation',
    'fix_fiscal_data', 'reactivate_paused', 'pause_listings',
    'snooze_tasks', 'dismiss_tasks', 'resolve_tasks_manual'
  )),
  task_ids UUID[] DEFAULT '{}',
  item_ids TEXT[] DEFAULT '{}',
  filter_rules JSONB DEFAULT '{}',
  apply_mode TEXT NOT NULL DEFAULT 'safe' CHECK (apply_mode IN ('safe', 'best_effort', 'dry_run')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'validating', 'executing', 'completed', 'partial', 'failed', 'cancelled'
  )),
  total_count INTEGER NOT NULL,
  validated_count INTEGER DEFAULT 0,
  applied_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  results JSONB DEFAULT '[]',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bulk_actions_org_seller ON ml_listing_bulk_actions(organization_id, seller_id);
CREATE INDEX idx_bulk_actions_status ON ml_listing_bulk_actions(status);

GRANT ALL ON ml_listing_bulk_actions TO service_role;
GRANT SELECT, INSERT, UPDATE ON ml_listing_bulk_actions TO authenticated;
```

### Copiloto Listing

```typescript
const LISTING_COPILOT_TOOLS = [
  // Visibilidade
  'list_critical_tasks',
  'list_tasks_by_type',
  'list_high_impact_tasks',
  'list_unhealthy_listings',
  'list_losing_buy_box',                  // novo (LOSING_BUY_BOX)

  // Análise
  'analyze_listing_health',
  'analyze_pricing_opportunity',
  'analyze_fiscal_compliance',
  'compare_listings_health',

  // Ações
  'resolve_tasks_bulk',
  'apply_price_suggestions',
  'activate_pricing_automation',

  // Relatórios
  'get_listing_summary',
  'get_top_problems',
]

const LISTING_COPILOT_PROMPT = `
Você é o copiloto Listing do e-Click. Ajuda o lojista a manter os anúncios saudáveis.

## EXEMPLOS DE COMANDOS
- "Quais anúncios precisam de atenção urgente hoje?"
- "Mostre os 10 anúncios mais críticos"
- "Quais estou perdendo Buy Box agora?"
- "Quais têm preço alto e podem reduzir?"
- "Quantos anúncios estão sem estoque?"
- "Quais bloqueiam emissão de NF-e?"
- "Liste anúncios pausados há mais de 7 dias"
- "Resolver todas as tarefas de qualidade dos top 20 produtos"
- "Aplicar sugestões de preço com queda < 5% nos produtos da curva A"

## REGRAS
- Sempre confirme antes de aplicar mudanças em massa
- Para tarefas de outros módulos, redirecione com deeplink
- Priorize por impacto financeiro estimado
- Sinalize ações que têm restrições (ex: automação de preço bloqueia edição manual)
`
```

### Score Consolidado

```typescript
class ListingHealthScoreEngine {
  async calculateForItem(itemId: string): Promise<HealthScore> {
    const quality = await this.qualityRepo.findLatest(itemId)
    const pricing = await this.pricingRepo.findLatest(itemId)
    const fiscal = await this.fiscalRepo.findLatest(itemId)
    const status = await this.statusRepo.findLatest(itemId)
    const product = await this.productRepo.findByMlItemId(itemId)

    const qualityScore = quality?.ml_score || 50
    // Pricing score considera Buy Box agora — perdendo Buy Box = score menor
    const pricingScore = this.calcPricingScore(pricing)
    const fiscalScore = fiscal?.fiscal_completeness_score || 50
    const statusScore = status?.status === 'active' ? 100 : 0
    const marginScore = this.calcMarginScore(product)
    const salesScore = this.calcSalesScore(product)

    const weights = {
      quality: 0.25,
      pricing: 0.20,    // inclui posição Buy Box
      fiscal: 0.15,
      status: 0.15,
      margin: 0.15,
      sales: 0.10,
    }

    const total = Math.round(
      qualityScore * weights.quality +
      pricingScore * weights.pricing +
      fiscalScore * weights.fiscal +
      statusScore * weights.status +
      marginScore * weights.margin +
      salesScore * weights.sales,
    )

    const issues: string[] = []
    if (qualityScore < 60) issues.push('quality_low')
    if (pricingScore < 60) issues.push('price_high')
    if (pricing?.buy_box_status === 'losing') issues.push('losing_buy_box')
    if (fiscalScore < 60) issues.push('fiscal_incomplete')
    if (statusScore === 0) issues.push('inactive')
    if (marginScore < 60) issues.push('margin_low')

    const recommendation = await this.generateTopRecommendation({
      itemId, total, qualityScore, pricingScore, fiscalScore, issues, pricing,
    })

    const prev = await this.scoreRepo.findLatest(itemId)
    const trend = this.calculateTrend(total, prev?.health_score)

    return await this.scoreRepo.create({
      ml_item_id: itemId,
      product_id: product?.id,
      organization_id: product?.organization_id,
      health_score: total,
      quality_score: qualityScore,
      pricing_score: pricingScore,
      fiscal_score: fiscalScore,
      status_score: statusScore,
      margin_score: marginScore,
      sales_score: salesScore,
      key_issues: issues,
      top_recommendation: recommendation.text,
      top_recommendation_impact: recommendation.impact,
      trend,
      prev_score: prev?.health_score,
      score_change: prev ? total - prev.health_score : 0,
    })
  }
}
```

---

## Resumo Geral

### Tabelas (8 novas + 1 VIEW)

| # | Tabela | Camada |
|---|--------|--------|
| 1 | `ml_listing_tasks` | L1 |
| 2 | `ml_listing_scan_logs` | L1 |
| 3 | `ml_listing_summary` | L1 |
| - | `v_listing_aggregated_signals` (VIEW) | L1 |
| 4 | `ml_listing_pricing_suggestions` (rico, com Buy Box) | L2 |
| 5 | `ml_listing_pricing_automation` | L2 |
| 6 | `ml_listing_fiscal_snapshots` | L3 |
| 7 | `ml_listing_pause_classifications` | L3 |
| 8 | `ml_listing_health_scores` | L4 |
| 9 | `ml_listing_bulk_actions` | L4 |

### Endpoints

| Camada | Endpoints |
|--------|-----------|
| L1 (Foundation + Agregação) | 16 |
| L2 (Pricing Intelligence + Catálogo) | 14 |
| L3 (Fiscal + Política) | 8 |
| L4 (IA + Score + Bulk) | 9 |
| **Total** | **47** |

### Estimativa de Custo IA

| Operação | Custo |
|---|---|
| Agregação VIEW (sem IA) | $0 |
| Scanners de stock/status (sem IA) | $0 |
| Scanner pricing (sem IA, regras) | $0 |
| Scanner catalog (sem IA, regras) | $0 |
| Scanner fiscal (sem IA, regras) | $0 |
| Score consolidado com IA insights | ~$0,01 por item |
| Copiloto (1 comando) | ~$0,01 |
| 1000 items × score mensal | ~$10/mês |

### Ordem de Implementação

| Sprint | Escopo |
|---|---|
| ~~Sprint 0~~ | ~~SMOKE TEST~~ ✅ feito 2026-05-10 (resultados nesse arquivo) |
| Sprint 1 (L1) | Migrations base + VIEW agregadora + scanner stock |
| Sprint 2 (L1) | Scanner status + dashboard + telas de tarefas |
| Sprint 3 (L2) | Scanner pricing (price_to_win 2-step) + telas + apply-batch |
| Sprint 4 (L2) | Scanner automation + ativação/configuração + scanner catalog |
| Sprint 5 (L3) | Scanner fiscal + telas + fix de attributes via PUT |
| Sprint 6 (L3) | Refinamento de classificação de pausados |
| Sprint 7 (L4) | Score consolidado (com Buy Box) + insights IA + telas |
| Sprint 8 (L4) | Copiloto Listing + ações em massa + auditoria |

---

## Pontos Críticos

### 1. Agregador, NÃO duplicador
A VIEW SQL é o coração do módulo. Cada vez que `aggregateSignals()` roda, lê do F7, F8, F9 sem copiar dados. Se o Quality Center mudar a lógica de score, o Listing Center automaticamente reflete a mudança.

### 2. Cron de auto-resolve (6h)
Tarefas agregadas que não aparecem mais na VIEW são auto-resolvidas com `status='resolved_auto'`. Mantém a lista viva e atualizada sem intervenção manual.

### 3. Bloqueio de edição com automação ativa
A partir de 18/03/2026, ML bloqueia `PUT /items/{id}` quando há automação de preço com `status='ACTIVE'`. O scanner salva isso em `blocks_manual_edit=true` e o sistema avisa antes de tentar edição manual em outros módulos.

### 4. Smoke test feito (Sprint 0 ✅)
Os 5 endpoints de pricing foram validados. Achados:
- `/suggestions/items/{id}` da spec original NÃO existe — substituído por `/items/{id}/price_to_win` (mais rico).
- `price_to_win` desbloqueia o card "Catálogo elegibilidade" (subiu de v1.1 → v1) e o card "LOSING_BUY_BOX" (novo).
- Scripts em `scripts/smoke-test-pricing-endpoints.mjs` e `smoke-test-suggestions-variants.mjs`.

### 5. Multi-conta sempre
Todo `getTokenForOrg(orgId, sellerId)` deve passar `sellerId` explícito (regra de `feedback_ml_multiconta_token`). Cron periódicos iteram com `getAllTokensForOrg(orgId)` + fan-out por conta.

### 6. Pacing de calls ML
200ms entre chamadas (= 5 req/s) consistente com `shipping-enrich`. Pra um seller com 1000 anúncios, scanner pricing leva ~5 minutos.

### 7. GRANTs explícitos
Toda migration termina com `GRANT ALL TO service_role; GRANT SELECT/etc TO authenticated`. RPC `_admin_exec_sql` não dá privileges automáticos (regra de `feedback_grant_admin_exec_sql`).

### 8. Deeplinks para módulos certos
Cada tarefa tem `deeplink_url` que aponta para o módulo onde ela é resolvida. Lojista nunca fica preso no Listing Center — ele é a porta de entrada, mas a resolução acontece no módulo dono da lógica.

---

## Mudanças vs spec original (v1 → v1.1)

| Tópico | Antes | Depois |
|---|---|---|
| Endpoint de sugestão | `/suggestions/items/{id}` (não existe) | `/items/{id}/price_to_win` (mais rico) |
| Schema `ml_listing_pricing_suggestions` | 4 campos baseados em premissa errada | 9 campos novos (buy_box_status, visit_share, competitors_sharing, catalog_product_id, winner, boosts, reason[], etc.) |
| Scanner pricing | 1 step (premissa errada) | 2 steps (lista IDs → price_to_win por item) |
| Card Catálogo/Buy Box | v1.1 | **v1** (catalog_product_id vem de graça) |
| Card LOSING_BUY_BOX | não existia | **novo** (status='losing' ou competitors_sharing > 0) |
| Boosts JSONB | não previsto | **capturado** — alimenta scanners de Full, frete grátis, etc. |
| Pacing | não definido | 200ms entre calls (5 req/s) |
| Sprint 0 | a fazer | ✅ feito, 4/5 endpoints validados, scripts em git |
