# F11 — ML Executive Dashboard IA

**Status:** Sprint 1 (E1) em entrega. E2/E3/E4 documentados mas não implementados.
**Versão:** 1.1 (pós-smoke 2026-05-11)
**Módulo backend:** `src/modules/executive-dashboard/`
**Migration foundation:** `supabase/migrations/20260542_executive_dashboard_foundation.sql`

---

## Princípio

Tela "home" do operador. Em 30s mostra: vendas, anúncios ativos, qualidade, campanhas,
tarefas pendentes do Listing Center, alto-impacto financeiro. Atualiza a cada 15 min
via cron; vendas refrescam <3s via Socket.IO `order:invalidate` + `?fresh=sales` query.

**Não duplica lógica.** VIEW `v_dashboard_aggregated_metrics` lê do F7/F8/F10 +
core. Mudanças nesses módulos refletem automaticamente.

## Diferença F10 (Listing Center) vs F11

| | F10 | F11 |
|---|---|---|
| Foco | Por anúncio | Por seller |
| Pergunta | "O que fazer neste anúncio?" | "Como está minha operação?" |
| UX | Lista priorizada | Cards executivos |

## Cortes do MVP

**Incluído (Sprint 1 — E1):** Agregação F7+F8+F10, vendas (orders) com `SUM(sale_price × quantity)`, anúncios ativos via `EXISTS … product_listings.is_active`, recomendações alto-impacto.

**Próximas camadas:**
- **E2 (Reputação)** — Sprint 3-4. Snapshot `/users/{id}` + histórico + risk alerts.
- **E3 (Logística)** — Sprint 5-7. Atrasos + Flex + Full.
- **E4 (Visitas)** — Sprint 8. `/items_visits/time_window` + conversão.

**Adiados pra módulos próprios:**
- Product Ads (cliques, ACOS, ROAS) → F12 Ads Intelligence
- Saldo Mercado Pago, faturamento → F13 Financeiro
- Minha Página (seguidores) → backlog

## Schema (Sprint 1 — migration 20260542)

Tabelas: `ml_dashboard_summary`, `ml_sales_daily`, `ml_dashboard_refresh_logs`.
VIEW: `v_dashboard_aggregated_metrics`.

Campos de E2/E3/E4 no `ml_dashboard_summary` ficam nullable até as respectivas
camadas entrarem. UI mostra "Sem dado · sync em Xm" via coverage alert pattern.

---

## ⚠️ Ajustes pós-smoke 2026-05-11 (FONTE DA VERDADE)

Smoke contra Vazzo VAZZO_ (2290161131) revelou desvios entre a spec original e os
shapes reais da API ML. Memória de referência: `reference_ml_api_shapes_f11.md`.
JSON do smoke: `smoke-f11-output.json`.

### Decisões aplicadas na E1 (migration 20260542)

1. **Platform string** = `'mercadolivre'` (sem underscore) — consistente com
   `orders.platform` e `product_listings.platform`. `seller_account_suppliers.marketplace`
   usa `'mercado_livre'` (com underscore) mas é coluna isolada de outro domínio.

2. **GMV** = `SUM(sale_price * quantity)` — `orders.total_amount` NÃO EXISTE.

3. **Anúncios ativos por seller** = `COUNT(DISTINCT ml_item_id) FROM ml_quality_snapshots WHERE seller_id = X`.
   A decisão inicial era usar `EXISTS (product_listings WHERE platform='mercadolivre' AND is_active=true)`,
   mas durante o apply descobriu-se que **`product_listings.account_id` está NULL em todas as 320 linhas** —
   não particiona por seller. Resultado: ambos sellers retornavam 309 (org-level). Fallback adotado:
   `ml_quality_snapshots` tem `seller_id` populado e cobre todos os itens sincronizados por F7.
   Verificado pós-fix: VAZZO_ 382 vs ESLAR_ 43 anúncios — multi-conta correto.
   Trade-off: depende do F7 sync estar atualizado. Próxima sprint pode refinar via `ml_listing_tasks` ou backfill de `product_listings.account_id`.

4. **Multi-conta token** = `MercadolivreService.getTokenForOrg(orgId, sellerId)` sempre com `sellerId`
   explícito. Sem isso pega a conta com `updated_at` mais recente (`feedback_ml_multiconta_token`).

5. **GRANT explícito** ao fim de toda migration via `_admin_exec_sql` (`feedback_grant_admin_exec_sql`).

6. **path-to-regexp** — controller ordena literais antes de catch-all `:id`
   (`feedback_path_to_regexp_v6`).

### Pendências obrigatórias pra E2 (Reputação)

7. **Métrica é `claims`, NÃO `complaints`.** API ML retorna `seller_reputation.metrics.claims.{rate,value}`.
   Tabelas `ml_seller_reputation_snapshots` / `_current` devem ter colunas `claims_count` / `claims_pct` em vez de `complaints_*`.

8. **`period`** é string `"60 days"` com espaço — NÃO `"60d"`.

9. **`rate`** vem como fração 0-1 (0.0082 = 0.82%) — multiplicar por 100 só pra UI.
   Persistir como fração no DB.

10. **Risk thresholds confirmados:** claims ≥ 0.8%, cancellations ≥ 0.4%, late_handling_time ≥ 5%.
    Limites ML: 1% / 0.5% / 6%. Vazzo está saudável (0.82% / 0.30% / 2.86%).

### Pendências obrigatórias pra E3 (Logística)

11. **`/flex/sites/MLB/items/{id}/v2` retorna SOMENTE `{has_flex: bool}`.** A spec original
    propunha `{has_flex, active, zones}` — esses campos **não existem nesse endpoint**.
    Tabela `ml_flex_status` deve ter apenas `has_flex BOOLEAN`. Pra distinguir
    "Flex elegível inativo" vs "Flex ativo entregando", investigar outro endpoint
    (sugestão: `/flex/items/{id}/status` ou `/users/{id}/flex` — não testado).

12. **`/shipments/{id}/delays` 404** com body `"Item doesnt have any delay"` é o
    sinal POSITIVO (sem atraso). Spec original já antecipava.

13. **Scanner E3 deve dedupar shipment_id** antes de iterar — orders multi-item de
    um mesmo pack compartilham `shipping.id`.

### Pendências obrigatórias pra E4 (Visitas)

14. **Usar exclusivamente `/items_visits/time_window?last=N&unit=day`.** A variante
    com `date_from`/`date_to` ISO retorna 400 BAD REQUEST ("Invalid request unknown
    date format"). A API ML não aceita ISO 8601 completo nesse endpoint.

15. **Shape `time_window`:** `{ user_id, date_from, date_to, total_visits, last, unit,
    results: [{ date, total, visits_detail: [{company, quantity}] }] }`.

16. **`results[]` vem fora de ordem cronológica** — sortar por `date` ao gravar
    em `ml_items_visits_daily`.

17. **Último dia tem `total` parcial** (ex: 255 às 12:20 vs ~2300 nos completos).
    Flagar incompleto no UI.

18. **`visits_detail[]`** permite breakdown por `company` (multimercados). Preservar
    no schema pra futuro multi-marketplace.

---

## Endpoints (Sprint 1 — E1)

```
GET    /executive/dashboard                 → snapshot completo (cache instantâneo)
GET    /executive/dashboard?fresh=sales     → refresca só vendas antes de retornar
POST   /executive/dashboard/refresh         → trigger refresh manual completo
GET    /executive/dashboard/refresh-logs    → histórico de refreshes
```

Próximas camadas adicionam endpoints próprios (`/executive/reputation/*`, etc.) —
ver spec antiga.

## Real-time

- **Cron** `*/15 * * * *` → `ExecutiveDashboardService.refreshAll()` pra todas orgs/sellers
- **Vendas <3s:** frontend escuta `order:invalidate` (já emitido pelo `MlWebhookDispatcherService` via `EventsGateway`)
  e faz `GET /executive/dashboard?fresh=sales`. Backend roda `refreshSalesOnly()` antes
  do read — UPDATE apenas dos campos de vendas no `ml_dashboard_summary`.
- Sem subscriber backend-side em Socket.IO — `EventsGateway` só EMITE.

## Custos

**$0/mês em IA.** Só consome Postgres + ML API.
