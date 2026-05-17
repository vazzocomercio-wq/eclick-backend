# Spike de Viabilidade — Coleta Pública Mercado Livre (e-Click Radar IA)

**Data:** 2026-05-17 · **Conta de teste:** org Vazzo (`4ef1aabd-…`), seller `2290161131` (token OAuth válido, confirmado via `/users/me`).
**Natureza:** spike descartável, read-only. Nenhum dado gravado, nenhuma migration, nenhum commit.

> ⚠️ **Resultado de cabeçalho:** a API pública de **busca geral do ML está morta** (`/sites/MLB/search` → 403 em todas as variantes) e `sold_quantity` de concorrentes é **inacessível**. Existe caminho viável, mas o "motor de venda estimada" precisa ser repensado sobre **visitas**, não sobre delta de vendas.

---

## Matriz de endpoints (testados nesta conta)

| Endpoint | Auth | Resultado | Serve pro Radar? |
|---|---|---|---|
| `/sites/MLB/search?q=` | token | ❌ 403 `forbidden` | morto |
| `/sites/MLB/search?category=` | token | ❌ 403 `forbidden` | morto |
| `/sites/MLB/search?seller_id=` | token | ❌ 403 `forbidden` | morto |
| `/users/{id}/items/search` — **próprio** | token | ✅ `paging{total,offset,limit}` | só catálogo próprio |
| `/users/{id}/items/search` — **terceiro** | token | ❌ 403 `Searching another user items is restricted` | morto |
| `/items/{id}` — **próprio** | token | ✅ 61 campos, `sold_quantity` exato | só próprio |
| `/items/{id}` — **terceiro** | token | ❌ 403 `access_denied` | morto |
| `/items/{id}` — anônimo | — | ❌ 403 `PolicyAgent` | morto |
| `/items?ids=` multiget — terceiro | token | ❌ 403 `access_denied` por item | morto |
| `/products/{catalog_id}` | token | ✅ | catálogo: detalhe do produto |
| `/products/{catalog_id}/items` | token | ✅ `paging` (limit ≤100) | **lista concorrentes do catálogo** |
| `/highlights/MLB/category/{cat}` | token | ✅ | best-sellers por categoria (com `position`) |
| `/users/{id}` — terceiro | token | ✅ | **reputação de concorrente** |
| `/users/{id}` — anônimo | — | ❌ bloqueado | — |
| `/categories/{id}` | — | ✅ público | nome, árvore, `total_items_in_this_category` |
| `/categories/{id}/attributes` | — | ✅ público | atributos `required`/`catalog_required` |
| `/visits/items?ids={id}` | token | ✅ (**1 id por chamada**) | **visitas lifetime de qualquer item** |
| `/items/{id}/visits/time_window` | token | ✅ | **série diária de visitas de qualquer item** |
| `/trends/MLB` | token | ✅ | keywords em alta |

---

## 1. Profundidade de paginação

A busca geral (`/sites/MLB/search`) **não responde** — não há o que paginar. As listagens que funcionam:

- **`/users/{id}/items/search`** (só do próprio seller): paginação padrão `offset`/`limit` (limit 50). Vazzo: `total = 618`. `offset=600` → OK (devolve a cauda). `offset=2000` → `Invalid limit and offset values`. **Teto prático em offset 1000** (padrão ML); acima disso é preciso `search_type=scan` + `scroll_id`.
- **`/products/{catalog_id}/items`**: paginação `{total, offset, limit}`, `limit` até 100. No produto testado: `total = 78` numa página só.

**Resposta:** paginação só existe pra listagens com escopo (catálogo próprio ou produto de catálogo), ambas com `offset/limit` padrão e teto ~1000. Busca aberta paginável: **não existe**.

## 2. Campos no resultado de busca

Como `/sites/MLB/search` morreu, o equivalente real é **`/products/{catalog_id}/items`**. Campos por item:

`item_id, seller_id, price, original_price, category_id, currency_id, condition, listing_type_id, warranty, tier, inventory_id, tags[] (first_party, kvs_primary, cart_eligible, extended_warranty_eligible…), deal_ids, official_store_id, shipping{free_shipping, mode, logistic_type, cost, tags}, seller_address{city,state}, sale_terms[], user_product_id, min_purchase_unit`

- **Presentes:** `price`, `original_price`, `listing_type_id`, `shipping.free_shipping`, `shipping.logistic_type` (ex.: `fulfillment`), `seller_id`, `condition`, `official_store_id`.
- **Ausentes:** `sold_quantity`, `available_quantity`, sinal explícito de posição/ranking (a ordem dos resultados pode ser um proxy de buy-box, mas não há campo nominal).

## 3. ⚠️ Confiabilidade do `sold_quantity` (CRÍTICO)

- **Item próprio** (`/items/{id}` com token do dono): `sold_quantity` vem **absoluto e exato** — ex.: `630` (com `available_quantity 2394`, `initial_quantity 3024`). Sem mascaramento, sem bucket.
- **Item de concorrente:**
  - `/items/{id}` com token → **403 `access_denied`** (não dá nem pra ler o item).
  - `/items?ids=` multiget → **403 `access_denied`** por item.
  - `/products/{id}/items` → devolve o item do concorrente, **mas sem o campo `sold_quantity`**.
  - `/sites/MLB/search` → morto.

**Resposta decisiva:** `sold_quantity` é exato **só para os anúncios da própria conta**. Para concorrentes é **inacessível por qualquer rota da API**. Um motor de venda estimada baseado em **delta de `sold_quantity` de concorrentes não é viável**.

## 4. Detalhe de item de concorrente (com vs sem token)

- **Sem token:** `/items/{id}` → 403 `PolicyAgent` / `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`.
- **Com token, item de terceiro:** 403 `access_denied`.
- **Com token, item próprio:** 61 campos completos.

`/items/{id}` é **gated ao dono**. O único dado de item de concorrente acessível é o conjunto reduzido de `/products/{catalog_id}/items` (seção 2) — e só para anúncios que estão num produto de catálogo.

## 5. Dados de vendedor

- `/users/{id}` de concorrente **sem token** → bloqueado (PolicyAgent).
- `/users/{id}` de concorrente **com token** → ✅ **funciona**: `nickname`, `seller_reputation` com `power_seller_status` (ex.: `platinum`), `level_id` (ex.: `5_green`), `transactions`. O bloco `metrics` (taxas de claims/cancelamentos/atrasos) apareceu para a conta da Vazzo no F11, mas **não apareceu** para o seller concorrente testado — a granularidade de `metrics` parece variar por seller; `power_seller_status`/`level_id`/`transactions` são consistentes.

**Resposta:** reputação de concorrente é coletável com token (nível, status power-seller, volume de transações). Métricas finas (rates) não são garantidas.

## 6. Atributos de categoria

`/categories/{id}/attributes` → **público, sem token**. Devolve array com `id, name, value_type, tags{required, catalog_required}, hierarchy, relevance`. Estrutura **plenamente útil** para benchmark de ficha técnica. `/categories/{id}` (também público) dá nome, `path_from_root` e `total_items_in_this_category`.

## 7. Rate limit

- ML **não expõe headers** de rate limit (sem `X-RateLimit-*`, sem `Retry-After`; só `Date` + `X-Request-Id`).
- Rajada de **60 requisições sequenciais** → 60×200, **0×429**. Não foi atingido nenhum limite nesse volume.
- ⚠️ Detalhe de escala: `/visits/items` aceita **1 id por chamada** (`maximum amount of items to query is 1`). Rastrear visitas de N itens = N requisições.

---

## Vetor alternativo decisivo — VISITAS

Não dá pra ler venda de concorrente, **mas dá pra ler visitas**:

- `/visits/items?ids={competitorItemId}` → total de visitas lifetime (ex.: `163072`).
- `/items/{competitorItemId}/visits/time_window?last=N&unit=day` → **série temporal diária de visitas** de qualquer item, inclusive de concorrente.

Visitas são um **proxy direto de demanda**. O motor de "venda estimada" deve ser reformulado como **visitas × taxa de conversão estimada**, em vez de delta de vendas.

## Outros vetores vivos

- `/highlights/MLB/category/{cat}` → produtos de catálogo best-seller por categoria, com `position` — sinal de **ranking**.
- `/products/{catalog_id}/items` → todos os sellers concorrendo num produto de catálogo (preço, frete, logística, loja oficial).
- `/trends/MLB` → keywords em alta.

## Lacuna de descoberta

Com `/sites/MLB/search` morto: anúncios **dentro de catálogo** são descobríveis (`/highlights` → `/products/{id}/items`). Anúncios **fora de catálogo** e o **catálogo de um concorrente específico** não são enumeráveis (`/users/{id}/items/search` de terceiro → 403 `restricted`). Esses casos exigem **seed manual** de `item_id`/`seller_id` no Radar.

---

## Conclusão

**A coleta pública suporta PARCIALMENTE o motor de venda estimada e ranking.** Suporta bem o **ranking, o monitoramento de preço/frete/logística e a reputação de concorrentes** — via `/products/{id}/items`, `/highlights`, `/users/{id}` (com token) e `/categories/*`. **Não suporta** o motor de venda estimada baseado em delta de `sold_quantity` de concorrentes: `sold_quantity` é exato apenas para anúncios próprios e `/items/{id}` de terceiros responde 403. O proxy viável é **visitas** — `/visits/items` e `/items/{id}/visits/time_window` funcionam para itens de concorrentes com série diária — portanto o motor deve ser arquitetado como **"demanda estimada = visitas × conversão estimada"**, e não como leitura direta de vendas.

## Implicações para os Motores 1 e 2

- **Motor de Ranking (1):** viável. Base = `/highlights` (best-sellers) + `/products/{id}/items` (preço/frete/loja oficial dos concorrentes) + `/users/{id}` (reputação). Coleta por catálogo + seed de sellers/itens-alvo.
- **Motor de Venda Estimada (2):** **pivotar.** Não há delta de vendas de concorrente. Arquitetar sobre `/items/{id}/visits/time_window` (série de visitas do concorrente) × uma taxa de conversão estimada (calibrável com os dados REAIS da Vazzo — visitas próprias vs vendas próprias, que temos exatos). Custo de coleta: 1 request por item por janela (sem batch em `/visits`).
