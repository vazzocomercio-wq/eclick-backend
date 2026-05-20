# Setup do Catálogo do WhatsApp Business (Vazzo)

Passo-a-passo pra deixar os produtos do e-Click aparecendo dentro do WhatsApp
Business da loja. O catálogo do WhatsApp Business **compartilha** o mesmo
catálogo Meta usado pra Instagram Shop / Facebook Shop — não é um catálogo
separado. O que muda é a "vinculação" desse catálogo ao WABA (WhatsApp
Business Account).

> **Por que não funciona automático:** a maioria dos passos depende de
> aprovação da Meta (App Review, verificação de WABA) e de credenciais que
> só você tem acesso. O código do e-Click cobre 100% da parte automatizável.

---

## Checklist resumido

- [ ] **1.** Configurar `META_APP_*` no env do Railway (backend)
- [ ] **2.** Criar app Meta em developers.facebook.com + aprovar scopes
- [ ] **3.** OAuth Meta no e-Click (`/dashboard/social-commerce/instagram` → "Conectar")
- [ ] **4.** Criar catálogo no Meta Commerce Manager (ou escolher existente)
- [ ] **5.** Setup do canal no e-Click (Page + IG + Catalog)
- [ ] **6.** Sincronizar produtos (1ª vez manual, depois auto)
- [ ] **7.** Vincular catálogo ao WABA (`/dashboard/social-commerce/whatsapp`)
- [ ] **8.** Validar via `wa.me/c/{phone}`

---

## 1. Variáveis de ambiente no Railway

No painel do Railway → projeto `eclick-backend` → Variables, adicionar:

```
META_APP_ID=<app id do Facebook Developer>
META_APP_SECRET=<app secret>
META_REDIRECT_URI=https://eclick.app.br/dashboard/social-commerce/instagram/callback
```

Sem essas 3 variáveis, todos os endpoints `/social-commerce/instagram/*` e
`/social-commerce/whatsapp/*` retornam **HTTP 503** com mensagem
"Integração Meta não configurada".

## 2. App Meta em developers.facebook.com

1. Acessar https://developers.facebook.com/apps
2. Criar app tipo **Business**
3. Adicionar produtos:
   - **Facebook Login for Business** (OAuth)
   - **Marketing API** (catálogo)
   - **WhatsApp Business Platform** (vincular catálogo ao WABA)
4. Em **App Review → Permissões**, solicitar:
   - `catalog_management` ✅ obrigatório
   - `business_management` ✅ obrigatório
   - `pages_read_engagement` ⚠️ requer App Review p/ uso em produção
   - `instagram_basic` ⚠️ requer App Review
   - `whatsapp_business_management` ⚠️ requer App Review
   - `whatsapp_business_messaging` ⚠️ requer App Review (só pra W4
     advanced/Cloud API — não necessário pro catalog do WhatsApp em si)

> **Modo Dev (sem App Review):** o app funciona, mas só com usuários
> cadastrados como **Testers/Admins** no app. Pra testar com a conta da
> Vazzo, adicionar a conta como Tester em **Roles → Roles**.

5. Em **Facebook Login → Configurações**, adicionar **Valid OAuth Redirect URIs**:

```
https://eclick.app.br/dashboard/social-commerce/instagram/callback
```

## 3. OAuth Meta no e-Click

1. Logar no e-Click como admin da Vazzo
2. Ir em `/dashboard/social-commerce/instagram`
3. Clicar **"Conectar Meta"**
4. Login + aprovar TODAS as permissões na tela da Meta
5. Callback volta pro e-Click → row criada em `social_commerce_channels`
   com `channel='instagram_shop'` e `status='connecting'`

**Validar:** GET `/social-commerce/instagram/status` deve retornar
`{ connected: true }`.

## 4. Catálogo no Meta Commerce Manager

1. Acessar https://business.facebook.com/commerce
2. Se não existe Business Manager, criar um (Vazzo Comércio)
3. **Commerce Manager → Catalogs → Create catalog**
4. Tipo: **E-commerce**
5. Nome: "Vazzo — Loja Própria"
6. Owner: o Business Manager da Vazzo

Anotar o **Catalog ID** (visível na URL ou no canto superior).

## 5. Setup do canal no e-Click

1. Em `/dashboard/social-commerce/instagram`, após conectar Meta, aparece o wizard
2. Escolher:
   - **Page** do Facebook (a página comercial da Vazzo)
   - **Instagram Account** (opcional, se já vinculado à Page)
   - **Catalog** (o criado no passo 4)
   - **Pixel** (opcional)
3. Clicar **"Vincular"**

Depois: row de `social_commerce_channels` ganha `external_catalog_id`,
`external_account_id` (Page ID) e `status='connected'`.

## 6. Sincronizar produtos pro Meta Catalog

### Manual (1ª vez)

1. Em `/dashboard/social-commerce/instagram`, clicar **"Sincronizar produtos"**
2. Backend roda `syncAll`: pega todos produtos com `storefront_visible=true`,
   converte pro shape Meta (title, description, price, images, etc) e faz
   `POST /{catalog_id}/items_batch` com método CREATE.

### Automático (depois)

A partir deste commit:

- **Auto-sync ao toggle visível:** quando lojista clica
  "Enviar pra loja" em Catálogo → Produtos, e-Click dispara
  `tryAutoSyncProducts` em paralelo (fire-and-forget). Lojista vê o
  produto na vitrine imediatamente e o Meta recebe os dados em até
  alguns segundos.
- **Cron diário 05:00 BRT** (`dailyCatalogSync`): varre todas as orgs
  com canal connected e roda `syncAll` — pega mudanças de preço/stock
  feitas fora do toggle de visibilidade + retentativa do que falhou.

**Diagnóstico:** ver logs do Railway com filtro `[auto-sync]` ou
`[daily-sync]`.

## 7. Vincular catálogo ao WhatsApp Business

1. WABA da Vazzo precisa estar **registrado e verificado** no Business
   Manager (https://business.facebook.com/wa/manage). Sem WABA verificado,
   nenhum catálogo pode ser vinculado.
2. No e-Click, ir em `/dashboard/social-commerce/whatsapp`
3. Clicar **"Iniciar configuração"** → wizard:
   - Escolher **WABA** (listado via Graph API)
   - Se WABA tem +1 número, escolher número específico
   - Escolher **catálogo** (o mesmo do Instagram Shop)
4. Confirmar → backend chama `POST /{waba_id}/product_catalogs?catalog_id=...`
   no Graph API + cria row `social_commerce_channels` com
   `channel='whatsapp_business'` e `external_account_id=waba_id`.

**Validar:**

- `/dashboard/social-commerce/whatsapp` deve mostrar card verde
  "Catálogo vinculado ao WhatsApp Business"
- DB: `select status, external_account_id, external_catalog_id from
  social_commerce_channels where channel='whatsapp_business' and
  organization_id='4ef1aabd-...'` → row existe, status='connected'

## 8. Validação end-to-end

### A. Catálogo aparece dentro do app WhatsApp Business da Vazzo

1. Abrir o app **WhatsApp Business** no celular conectado ao número da Vazzo
2. Configurações → **Ferramentas comerciais** → **Catálogo**
3. Os produtos sincronizados devem aparecer (pode demorar minutos
   após o sync inicial)

### B. Cliente acessa via wa.me/c/

1. Pegar o número WhatsApp comercial da Vazzo (com DDD, sem +)
2. Acessar `https://wa.me/c/5571XXXXXXXX` no celular
3. App do WhatsApp abre direto na tela de catálogo da loja

### C. Widget na Loja Própria

1. Acessar `https://eclick.app.br/loja/vazzo` (ou `https://vazzo.com.br` quando
   provedores voltarem)
2. Botão flutuante verde do WhatsApp aparece no canto inferior direito
3. Clicar → menu com **"Conversar com a loja"** + **"Ver catálogo no
   WhatsApp"** (essa opção só aparece quando há catalog vinculado)

---

## Troubleshooting

| Sintoma | Causa provável | Fix |
|---|---|---|
| OAuth Meta → "App não disponível" | App em modo Dev e usuário não é Tester | Adicionar usuário em **Roles → Roles → Add Testers** |
| `/social-commerce/whatsapp/wabas` retorna `[]` | Scope `whatsapp_business_management` não aprovado, ou WABA não existe | Aprovar scope em App Review OU criar WABA no Business Manager |
| Sync falha com `Invalid OAuth access token` | Token expirou (60 dias long-lived) | Re-conectar Meta — OAuth gera novo token long-lived |
| Sync falha com `price must be greater than 0` | Produto com `price=null` ou `0` | Setar preço no e-Click antes de sincronizar |
| Catalog não aparece no app WhatsApp Business | Pode demorar 5-15min após vincular | Aguardar; conferir se o WABA está verificado |
| `wa.me/c/{phone}` abre conversa em vez do catálogo | Número não tem catalog vinculado, OU app WhatsApp Business desinstalado no celular dono do número | Re-vincular pelo painel e-Click |
| Logs `[auto-sync] skipped:true` | Org não tem canal connected — esperado quando lojista ainda não configurou | Conectar Meta primeiro |

---

## Status atual da Vazzo (no momento deste doc)

DB confirmou: `social_commerce_channels` sem row pra org Vazzo. Nenhum dos 8
passos foi feito. Lista é o caminho do zero.

Quando provedores voltarem (Railway + Netlify), começar pelo passo 1.
