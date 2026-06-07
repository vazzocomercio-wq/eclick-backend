# Épico: Ingestão Viva de Pedidos Multicanal

> Status: **DESENHO** (não iniciado). Pré-requisito para dropship em Shopee, TikTok Shop e Loja Própria.
> Contexto: o motor de dropship (3 camadas — captação, funil de expedição, OC auditável)
> está completo e em produção para Mercado Livre. Os outros canais não funcionam de ponta
> a ponta porque **não há ingestão viva de pedidos** deles na tabela `orders`.

## Diagnóstico que originou o épico (2026-06-07)

- Tabela `orders` tem 10.828 pedidos ML (vivos), **731 Shopee e 47 TikTok que são um IMPORT ÚNICO**
  (todos criados em ~5 min em 01/06 — não há sync contínuo).
- Pedidos de **Loja Própria nunca entram em `orders`**: vivem em `storefront_orders` e são
  transformados por um *mapper de leitura* (`orders.service.ts`) só na hora de exibir.
- Resultado: o dropship (que lê `orders`) só enxerga ML de verdade. Mapear um fornecedor
  Shopee/TikTok (habilitado na Onda C1) só "pega" os pedidos históricos; nada novo flui.

## Princípio

**A tabela `orders` é a fonte única da verdade.** Todo canal precisa alimentá-la
continuamente. Tudo a jusante (dropship, DRE/financeiro, fulfillment, comunicação,
telemetria) lê dela. Padrão platform-agnostic: cada canal = um adapter + um cron de sync,
sem tocar nos motores a jusante.

## Padrão de referência (Mercado Livre — já existe)

`src/modules/sales-aggregator/services/orders-ingestion.service.ts`:
1. **Cron** busca pedidos por janela de data, por conta conectada (token correto de cada conta).
2. **`buildOrderRows`** transforma o pedido da API → linha canônica de `orders`.
3. **Enriquecimento de envio**: status, `logistic_type`, `date_shipped`, endereço.
4. **Enriquecimento de comprador**: billing/CPF.
5. **Upsert idempotente** (`onConflict: source,external_order_id,sku`).

Cada canal novo replica esse fluxo com seu adapter.

## Escopo por canal

### Shopee — esforço M
- ✅ Existe: `ShopeeAdapter` (`listOrders`, `getOrderDetail`, `extractBuyerBilling`),
  `shop_id`/tokens em `marketplace_connections`.
- ❌ Falta: o **cron de sync** (adapter → buildRows Shopee → upsert). As "mãos" existem, o "cérebro" não.
- Mapeamentos críticos: `order_status` Shopee → status canônico; logística → `logistic_type`;
  data de postagem → `shipped_at`. Carimbar `shop_id` no pedido (resolve multi-loja).

### TikTok Shop — esforço L
- ❌ **Não há adapter** no eclick-backend. Os 47 pedidos vieram de fora.
- ⚠️ Verificar PRIMEIRO se há infra TikTok reaproveitável no `eclick-active` (memória sugere
  módulo `tiktok-shop`) ou se o adapter precisa ser feito do zero (auth HMAC, order search +
  detalhe, billing). Maior dos três pela ausência de base.

### Loja Própria (storefront) — esforço S→M
- ✅ Existe: `storefront_orders` + mapper em `orders.service.ts` que já sabe a transformação.
- ❌ Falta: **persistir** `storefront_orders` → `orders` (hoje só roda na leitura).
  - (a) Bridge no checkout (espelha na venda) + backfill — **recomendado** (mantém fonte única).
  - (b) Dropship ler também `storefront_orders` — mais simples, mas espalha a fonte da verdade.
- Account = `'loja'` (canal de loja única, já preparado na Onda C1).

## Camadas transversais (todos os canais)

1. **Mapa de status de envio por canal** → vocabulário canônico (`ready_to_ship/shipped/delivered`).
   É o que liga ao funil de expedição do dropship (sem isso a OC não fecha por expedição).
2. **Modal por canal** → `logistic_type` (rótulos Flex/Coletas/equivalentes).
3. **Data real de postagem** → `shipped_at` (precisão da coorte da OC).
4. **`shop_id`/account no pedido** → habilita multi-loja sem retrabalho.
5. **Idempotência + pacing** (rate limits) + **token por conta** (multi-conta).
6. **Webhook + cron de reconciliação** (webhook de novo pedido/mudança de status; cron como rede).

## Como fecha o dropship

Com a ingestão viva, **nada novo é preciso no dropship**: o mapeamento (C1), o funil
(Ondas A/B) e a OC auditável passam a funcionar automaticamente para o canal. Multi-loja
vira detalhe (`shop_id` já carimbado). "Loja própria" deixa de ser bloqueio (já estará em `orders`).

## Ordem de ataque recomendada

1. **Loja própria** (menor, base pronta) — valida o padrão no canal mais simples.
2. **Shopee** (adapter pronto, falta o cron) — 1º marketplace externo vivo.
3. **TikTok** (resolver a incerteza da base antes; maior) — por último.

## Decisões pendentes (quando começar)

- Loja própria: bridge no checkout (a) vs dropship ler storefront (b).
- Webhook vs polling por canal.
- Profundidade do backfill por canal.

---

## Histórico do dropship (o que já está pronto, em produção)

- **Onda A** (`58c9a3b`): captura `date_shipped` real do ML → `orders.shipped_at` (mig 20260694);
  funil carimba expedição com data real; produto não-cadastrado vira `on_hold` (radar ativo);
  OC mostra data de compra real (`orders.sold_at`).
- **Onda B** (back `2faf4d0`, front `ffc140e`): `logistic_type` na identificação e no item da OC
  (mig 20260695); Full fora da OC por venda (parqueado); OC mostra Compra · Postagem · Modal.
- **Onda C1** (back `f1166c7`, front `f31deb8`): habilita TikTok Shop e Loja Própria como canais
  de vínculo conta→fornecedor (mig 20260696, CHECK + conta-única). Shopee já funcionava.
- **Funil F2 + tabela `shipments`**: construídos por outra sessão (migs 20260692/20260693) —
  régua `shipped` (não `ready_to_ship`), confirmação do parceiro, OC por data de expedição.
