# M3 — Plano de Refactor: Colunas Marketplace na `products` → `product_listings`

> **Status: SPEC ONLY — não executar sem aprovação explícita.**
> Onda 1 / Movimento 3.
> Criado: 2026-05-06.

## Problema

A tabela `products` tem **63 colunas** misturando responsabilidades. Entre elas, **15 colunas marketplace-specific** que deveriam viver em `product_listings` (tabela já existente, com FK pra products):

| Coluna | Tipo | Origem |
|--------|------|--------|
| `ml_listing_type` | text | ML — `classic` / `gold_special` / `gold_pro` |
| `ml_free_shipping` | boolean | ML — flag de frete grátis |
| `ml_flex` | boolean | ML — Flex envio próprio |
| `ml_item_id` | text | ML — MLB ID do anúncio |
| `ml_listing_id` | text | ML — variante do MLB ID |
| `ml_permalink` | text | ML — URL do anúncio |
| `ml_catalog_id` | text | ML — catálogo ML |
| `ml_title` | text | ML — título específico do ML |
| `category_ml_id` | text | ML — categoria ML |
| `shopee_xpress` | boolean | Shopee — entrega expressa |
| `shopee_quick_delivery` | boolean | Shopee — entrega rápida |
| `shopee_pickup` | boolean | Shopee — retirada |
| `anatel_homologation` | text | Marketplaces regulados — homologação |
| `gtin` | text | EAN/GTIN — usado por todos os marketplaces (mantém) |
| `condition` | text | new/used — usado por todos (mantém) |

## Justificativa

1. **Multi-marketplace**: hoje cada produto tem **1 row em products**, mas pode estar publicado em **N marketplaces** (ML + Shopee + Amazon + Magalu). Colunas `ml_*`/`shopee_*` na products forçam esquema 1:1 errado.

2. **Acoplamento**: adicionar Shopee/Amazon/Magalu hoje significa adicionar **mais colunas** na products (já com 63). Insustentável.

3. **Crescimento esperado**: cada novo marketplace adiciona 5-15 colunas específicas. Em 6 meses, products tem 100+ colunas.

4. **product_listings já existe**: tabela criada exatamente pra isso. Hoje subutilizada — só guarda alguns campos. Ela deveria ser o único lugar de dados marketplace-specific.

## Estado atual de `product_listings`

> **TODO**: rodar query no Supabase pra confirmar schema atual antes de executar:
> ```sql
> SELECT column_name, data_type, is_nullable
> FROM information_schema.columns
> WHERE table_name = 'product_listings' AND table_schema = 'public'
> ORDER BY ordinal_position;
> ```

Sabemos pelos modules existentes que ela tem pelo menos: `id`, `product_id`, `marketplace`, `external_id`, `external_url`, `status`. Mas falta avaliar se cobre `listing_type`, `free_shipping`, `flex`, `xpress`, etc.

## Plano de Refactor (faseado)

### Fase 1 — Schema preparation (1 sprint)

**Migration**: estende `product_listings` com colunas marketplace-specific:

```sql
ALTER TABLE product_listings
  ADD COLUMN IF NOT EXISTS listing_type     text,    -- ML/Shopee/etc — generalizado
  ADD COLUMN IF NOT EXISTS free_shipping    boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS quick_delivery   boolean DEFAULT false,  -- ml_flex/shopee_quick
  ADD COLUMN IF NOT EXISTS pickup_enabled   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS xpress           boolean DEFAULT false,  -- shopee
  ADD COLUMN IF NOT EXISTS marketplace_data jsonb DEFAULT '{}',     -- catch-all
  ADD COLUMN IF NOT EXISTS marketplace_title text,                  -- ml_title quando difere de products.name
  ADD COLUMN IF NOT EXISTS category_external_id text,               -- category_ml_id generalizado
  ADD COLUMN IF NOT EXISTS permalink        text,                   -- ml_permalink
  ADD COLUMN IF NOT EXISTS catalog_id       text;                   -- ml_catalog_id

-- Indexes
CREATE INDEX IF NOT EXISTS idx_product_listings_external_id
  ON product_listings(marketplace, external_id) WHERE external_id IS NOT NULL;
```

**Sem migrar dados ainda** — apenas adiciona colunas. Aplicação continua usando `products.ml_*` como antes. Zero downtime.

### Fase 2 — Backfill (1 sprint)

Cron 1x que copia dados de `products.ml_*` pra `product_listings` row correspondente (criando rows novas se necessário).

```sql
-- Pseudocódigo (SQL real precisa de loops + checks de duplicação)
INSERT INTO product_listings (product_id, marketplace, external_id, listing_type, free_shipping, ...)
SELECT
  p.id, 'mercado_livre',
  p.ml_item_id, p.ml_listing_type, p.ml_free_shipping, ...
FROM products p
WHERE p.ml_item_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_listings pl
    WHERE pl.product_id = p.id AND pl.marketplace = 'mercado_livre'
  );
```

**Riscos**: produtos com inconsistência (ml_item_id setado mas ml_listing_type null) precisam tratamento específico.

### Fase 3 — Dual-write (2 sprints)

Toda code path que escreve em `products.ml_*` passa a escrever **também** em `product_listings`. Apps mantêm leitura de products durante esse período.

Reads de `product_listings` validam que data está sincronizado com `products.ml_*`. Se diverge, log alerta.

### Fase 4 — Read migration (1-2 sprints)

Code paths trocam reads de `products.ml_*` → JOIN com `product_listings`. Apps frontend ajustam tipos.

Modules afetados (estimativa baseada em grep):
- `mercadolivre/` (heavy use)
- `ml-ads/`
- `marketplace-channels/`
- `marketplace/`
- `creative/creative-ml-publisher.service.ts` (usa `category_ml_id`)
- Frontend `dashboard/produtos/[id]/editar/`

### Fase 5 — Drop (1 sprint, depois de 2-4 semanas em prod sem reclamação)

```sql
ALTER TABLE products
  DROP COLUMN IF EXISTS ml_listing_type,
  DROP COLUMN IF EXISTS ml_free_shipping,
  DROP COLUMN IF EXISTS ml_flex,
  -- ...
```

## Riscos

1. **Performance**: queries que hoje fazem `SELECT * FROM products` ganham JOIN. Pode degradar listagens.
   - Mitigação: índices em `product_listings(product_id, marketplace)` + materialized views se necessário.

2. **Consistency window** (Fase 3): durante dual-write, divergência é possível. Log + reconciliação manual.

3. **Frontend breakage**: tipos do TS mudam. Tests E2E necessários.

4. **Modules legados** que ninguém testa há tempo: pode quebrar fluxos não-óbvios.

5. **`gtin`, `condition`, `weight_kg` etc**: esses são UNIVERSAIS (todo marketplace usa). NÃO devem migrar. Manter na products.

## Testes Mandatórios

Antes de Fase 5 (drop), validar em ambiente de staging:
- [ ] Criar produto novo + publicar em ML → product_listings.* preenchido, products.ml_* vazio
- [ ] Editar produto → mudanças refletem no product_listings
- [ ] Sync ML (F4 do creative-ml) → atualiza product_listings, não products
- [ ] Lista de produtos em /dashboard/produtos → renderiza com JOINs
- [ ] Edição de produto → todos os campos editáveis funcionam
- [ ] Backup + restore de DB cobre product_listings novo

## Decisão pendente

> Quem aprova execução desta refactor? Quando?

Recomendação: **NÃO executar** durante Onda 1 (foco em features novas). Programar pra **Onda 2** ou **Onda 3** quando time tiver mais maturidade na nova estrutura.

## Out of scope

- Migrar `products.attributes` jsonb (genérico, mantém)
- Migrar `products.fiscal` jsonb (mantém — fiscal não é marketplace-specific)
- Migrar `products.variations` jsonb (mantém — variações são do produto, não do listing)
- Migrar `products.wholesale_*` (mantém — atacado é estratégia comercial, não marketplace)

## Referências

- Tabela `products` atual: 63 colunas, 16+ FKs apontando.
- Tabela `product_listings` existente: ver schema via query informational.
- Módulos que tocam ml_*: grep por "ml_" em `src/modules/` mostra ~150+ ocorrências.
