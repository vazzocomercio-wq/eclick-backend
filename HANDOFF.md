# HANDOFF — e-Click SaaS

> **Última atualização:** 2026-05-06 — fim da sessão que entregou Onda 4 completa.

## TL;DR

- **Onda 1 (Catálogo AI), Onda 3 (Social+Ads) e Onda 4 (Loja Autônoma) entregues no SaaS.**
- **Onda 2 (WhatsApp Commerce) e Onda 3/S5 (Calendário) vivem no Active** — projeto separado em `C:\Users\ECLICK 1\eclick-active`.
- **Pendência ativa:** setar 2 envs no Railway (SaaS) + 1 env (Active) pra ativar bridge SaaS↔Active.

## Estrutura dos Repos

```
C:\Users\ECLICK 1\eclick-backend     ← NestJS API (este projeto)
C:\Users\ECLICK 1\eclick-frontend    ← Next.js 15 admin
C:\Users\ECLICK 1\eclick-active      ← Monorepo Turborepo (api + web), DISTINTO
```

## Status das Ondas

| Onda | Escopo | Status | Projeto |
|---|---|---|---|
| 1 | Catálogo AI Commerce | ✅ Em prod | SaaS |
| 2 | WhatsApp Commerce | ✅ Em prod | Active |
| 3 — S1-S4, S6 | Social + Ads | ✅ Em prod | SaaS |
| 3 — S5 | Calendário de Conteúdo | ✅ (entregue p/ Active session, prompt enviado) | Active |
| 4 — A1-A6 | Loja Autônoma | ✅ Em prod | SaaS |
| 4 — A3 (Active side) | Bridge endpoints | ✅ (entregue p/ Active session, prompt enviado) | Active |

## Modules SaaS (eclick-backend) — todos no AppModule

```
src/modules/
├── ai/                    LlmService + FEATURE_REGISTRY (defaults.ts)
├── copilot/               Copiloto flutuante v1 (responde dúvidas por rota)
├── creative/              IA Criativo (F6 — listing/imagem/vídeo/Canva/ML publish)
├── products/              Catálogo + enrichment + landing pages (Onda 1)
├── products-analytics/    Analytics social/ads agregado (Onda 3 / S6)
├── pricing-ai/            ★ Onda 4 / A1 — sugestões de preço com 3 cenários
├── store-automation/      ★ Onda 4 / A3 — motor + executor + bridge Active
├── kits/                  ★ Onda 4 / A5 — kits/combos com IA
├── storefront/            ★ Onda 4 / A2 — rules + collections + público
├── store-copilot/         ★ Onda 4 / A4 — assistente admin com tools
├── store-config/          ★ Onda 4 / A6 — white-label + DNS verify + rotas públicas
├── social-content/        Onda 3 / S1 — geração de conteúdo social
├── social-commerce/       Onda 3 / S2/S3 — Instagram Shop + TikTok readiness
├── ads-campaigns/         Onda 3 / S4/S6 — Ads Hub + Meta Ads OAuth + metrics
├── ml-ads/, atendente-ia/, … (módulos pré-existentes)
```

## Pages SaaS (eclick-frontend)

```
src/app/dashboard/
├── pricing-ai/            (A1) Painel de sugestões + /rules
├── automation/            (A3) Inbox de ações + /config
├── kits/                  (A5)
├── collections/           (A2)
├── store-copilot/         (A4) Chat page
├── store/config/          (A6) White-label editor
├── ads-campaigns/         (Onda 3) Dashboard + /new + /[id]
├── social/                (Onda 3) Feed + /generate + /content/[id]
├── social-commerce/       (Onda 3) Instagram Shop config
├── produtos/              (Onda 1)
├── creative/              (F6)
└── (outras pré-existentes)
```

## Tabelas novas (todas com RLS por organization_members)

| Tabela | Onda | Migration |
|---|---|---|
| `social_content` | 3/S1 | 20260519 |
| `social_commerce_channels` | 3/S2 | 20260520 |
| `social_commerce_products` | 3/S2 | 20260520 |
| `ads_campaigns` | 3/S4 | 20260521 |
| `pricing_ai_suggestions` | 4/A1 | 20260522 |
| `pricing_ai_rules` | 4/A1 | 20260522 |
| `store_automation_actions` | 4/A3 | 20260523 |
| `store_automation_config` | 4/A3 | 20260523 |
| `product_kits` | 4/A5 | 20260524 |
| `storefront_rules` | 4/A2 | 20260525 |
| `product_collections` | 4/A2 | 20260525 |
| `store_config` | 4/A6 | 20260526 |

Todas em `supabase/migrations/`. Aplicar via:
```bash
node scripts/apply-migration.mjs supabase/migrations/<file>.sql
```
(usa `_admin_exec_sql` RPC — bootstrap em `00000000_admin_exec_sql_rpc.sql`)

## Workers ativos pós-deploy

| Worker | Tick | Boot delay | Kill-switch |
|---|---|---|---|
| `products-enrichment` (Onda 1) | 5min | 90s | `DISABLE_PRODUCTS_ENRICHMENT_WORKER=true` |
| `social-commerce` (Onda 3) | 60min | 120s | `DISABLE_SOCIAL_COMMERCE_WORKER=true` |
| `ads-metrics` (Onda 3) | 6h | 180s | `DISABLE_ADS_METRICS_WORKER=true` |
| `store-automation` (Onda 4) | 60min | 240s | `DISABLE_STORE_AUTOMATION_WORKER=true` |

Todos com `busy` flag (não overlap) e graceful standby quando env-deps faltam (META_APP_ID, etc).

## Feature Keys do FEATURE_REGISTRY

```
campaign_copy, product_title, embeddings, atendente_response, campaign_card,
ml_question_suggest, ml_question_transform, ml_question_auto_send,
creative_vision, creative_listing, creative_image_prompts, creative_image,
creative_video_prompts, copilot_help, catalog_enrichment,
social_content_gen, ads_campaign_gen,         ← Onda 3
pricing_ai_suggest, kits_generate, collections_generate, store_copilot  ← Onda 4
```

## Bridge SaaS↔Active — ✅ OPERACIONAL

### URLs
- SaaS API: `https://api.eclick.app.br`
- Active API: `https://api.active.eclick.app.br`

### Smoke test passou (2026-05-06)
```json
{
  "configured": true,
  "reachable": true,
  "authenticated": true,
  "response": {
    "ok": true,
    "sent": false,
    "queued_for_digest": true,
    "execution_id": "66a026bb-5bbe-4462-83c4-6d0068bd367d"
  }
}
```

### Histórico
1. Envs setadas no Railway dos dois lados (mesmo secret)
2. Bridge alcançável e auth OK
3. Bug FK em `active.automation_executions` bloqueava inserts —
   Active corrigiu via `DROP CONSTRAINT automation_executions_org_id_fkey`
4. Smoke test re-rodado: 3 booleans `true`, execution_id retornado

### O que está liberado
- Auto-execução de `notify_lojista` (WhatsApp ao lojista)
- Auto-execução de `send_recovery` (cart recovery em massa)
- Worker `store-automation` (60min tick) dispara análise + auto-execute
  pra triggers em `config.auto_execute_triggers`

Lojista habilita por trigger em `/dashboard/automation/config`.

### 3. Validar
Após reboot dos Railways, chamar com JWT autenticado:
```
GET https://<saas-api>/store-automation/bridge-health
```

Esperado:
```json
{
  "configured":    true,
  "reachable":     true,
  "authenticated": true,
  "response":      { "ok": true, "queued_for_digest": true }
}
```

### 4. O que destrava

Quando os 3 booleans = true, está liberado:
- Auto-execução do trigger `notify_lojista` (manda WhatsApp ao lojista quando severity ≥ medium)
- Auto-execução do trigger `send_recovery` (cart recovery via WhatsApp em massa)
- Worker do SaaS roda análise diária e dispara ações pendentes que estão em `auto_execute_triggers`

Lojista habilita por trigger em `/dashboard/automation/config`.

## Convenções/regras do projeto (memória do user)

- **Migrations:** date-based `YYYYMMDD_name.sql` em `supabase/migrations/`
- **Aplicar SQL:** sempre via `node scripts/apply-migration.mjs <file>` (NUNCA pedir pra colar no Studio — user já configurou _admin_exec_sql RPC)
- **TSC:** rodar `npx tsc --noEmit` (ou `node node_modules/typescript/bin/tsc --noEmit` no Windows) ao fim de cada sprint, zero erros
- **Commits:** mensagens em português, seguindo formato `feat(módulo): descrição` com `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` no rodapé
- **Responsividade:** todas as UIs precisam funcionar em mobile/tablet/desktop (não opcional)
- **Tags visuais:** pílulas coloridas (rounded-full + border + bg/[10%] + text mesma cor) — semânticas fixas + livres com hash
- **Workflow do user:** entrega blocos (A/B/C…) com PARTES; sempre rodar tsc api+web ao fim
- **Beep convention:** 800Hz=conclusão, 1200Hz×2=needs-input, 400Hz×3=erro crítico (Active só)
- **Active vs SaaS:** projetos separados, schemas diferentes (`active.*` vs `public.*`), sempre verificar antes onde uma feature mora — user fala "no Active" ou "no SaaS"

## Setup necessário (envs Railway SaaS — todas as integrações)

| Env | Pra quê | Status |
|---|---|---|
| `META_APP_ID` | Catálogo IG/FB (Onda 3 S2) + Meta Ads (Onda 3 S6) | A definir |
| `META_APP_SECRET` | idem | A definir |
| `META_REDIRECT_URI` | OAuth Catalog | A definir |
| `META_ADS_REDIRECT_URI` | OAuth Marketing | A definir (ou reusar) |
| `ACTIVE_AUTOMATION_BRIDGE_URL` | Bridge A3 SaaS→Active | **PENDENTE — necessário** |
| `ACTIVE_AUTOMATION_BRIDGE_SECRET` | idem | **PENDENTE — usar valor acima** |
| `STORE_DOMAIN_TARGET` | DNS verify do white-label (default: storefront.eclick.app.br) | Opcional |

## Out-of-scope que ficou pra próximas ondas

- **A3 detectores** `competitor_*`, `low_conversion`, `margin_erosion` — stub vazio (precisam de dados que não existem ainda ou vivem no Active)
- **Storefront rules editor visual** — CRUD existe via API mas só Collections tem UI dedicada
- **Editor visual drag-drop** pra slides do Carousel (S1) e items do Kit (A5)
- **Domain SSL automation** real (Let's Encrypt) — apenas DNS verify foi implementado
- **Checkout web público** completo — só listagem de produtos por enquanto
- **Widget IA da loja pública** — config existe (`ai_seller_widget_enabled`) mas UI do widget é Onda 5
- **Propagação de mudança de preço** pra ML/Shopee/IG (PricingAi atualiza só `products.price` no SaaS)
- **TikTok Shop API real** — só readiness checklist (S3) ficou pronto
- **Google Ads OAuth + publish** — só Meta Ads (S6 cobriu)
- **Tela `/dashboard/ads-campaigns/top`** consumindo `/products/analytics-social/top` (endpoint pronto, UI dedicada futura)

## Memória do user (relevante)

- Email: vazzocomercio@gmail.com
- Active intelligence: doc canônico em `eclick-active/docs/analytics-design.md`, 8 blocos A-H
- Carrossel animado de prompts: replicado em 4 lugares no SaaS (AdsAIChat, AICardGenerator, /producao/conteudo, FloatingCopilot empty state)
- Intelligence Hub do SaaS já em prod, NÃO retomar nem aplicar no Active
