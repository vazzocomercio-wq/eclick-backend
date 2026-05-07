# eclick-backend

Backend do projeto eclick-saas, construído com NestJS.

## Tecnologias

- [NestJS](https://nestjs.com/)
- [TypeScript](https://www.typescriptlang.org/)
- [TypeORM](https://typeorm.io/) / [Prisma](https://www.prisma.io/)
- [PostgreSQL](https://www.postgresql.org/)
- [JWT](https://jwt.io/) para autenticação

## Estrutura de Pastas

```
eclick-backend/
├── src/
│   ├── modules/          # Módulos da aplicação (auth, users, etc.)
│   ├── common/           # Filtros, guards, interceptors, pipes
│   ├── config/           # Configurações da aplicação
│   └── main.ts           # Entry point
├── test/                 # Testes e2e
└── ...
```

## Instalação

```bash
npm install
```

## Desenvolvimento

```bash
npm run start:dev
```

API disponível em [http://localhost:3001](http://localhost:3001).

## Build

```bash
npm run build
npm run start:prod
```

## Testes

```bash
# unit tests
npm run test

# e2e tests
npm run test:e2e

# test coverage
npm run test:cov
```

## Variáveis de Ambiente

Copie `.env.example` para `.env` e preencha os valores.

```bash
cp .env.example .env
```

## Webhooks externos — configuração manual

### Mercado Livre (Pós-venda IA + Perguntas IA)

O módulo `ml-postsale` (atendimento pós-venda) e `ml-questions` (perguntas
pré-venda) recebem eventos do ML em tempo real via webhook. Sem polling
no MVP 1 — webhook é a única fonte de eventos.

**Como registrar (uma vez por app ML):**

1. Acessar https://developers.mercadolivre.com.br/devcenter
2. Selecionar a aplicação do e-Click
3. Em **Notificações > URL de Callback**, configurar:
   ```
   https://api.eclick.app.br/ml/webhook
   ```
4. Em **Tópicos**, marcar:
   - `messages`   (pós-venda — mensagens dentro de pedidos)
   - `questions`  (pré-venda — perguntas em anúncios)
   - `orders_v2`  (sync de pedidos — opcional, ainda não consumido)
   - `claims`     (reclamações — futuro, ainda não consumido)
5. Salvar

**Validação local (sem precisar do ML):**

```bash
curl -i -X POST http://localhost:3001/ml/webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "topic": "messages",
    "user_id": 2290161131,
    "resource": "/messages/packs/123/sellers/2290161131"
  }'
# Esperado: HTTP/1.1 200 OK + {"ok":true}
```

**Smoke teste em produção:**

Quando uma mensagem nova chegar via ML, observar no Railway log:
```
[MlWebhookController] [ml-webhook] topic=messages seller=<id> resource=/messages/packs/.../sellers/...
```

E verificar row em `ml_conversations` + `ml_messages` + `ml_ai_suggestions`
no Supabase.

### Endpoints REST do pós-venda

Sob `/ml/postsale/*`, todos com `SupabaseAuthGuard`:

| Método | Rota                                      | Descrição                                    |
|--------|-------------------------------------------|----------------------------------------------|
| GET    | `/conversations`                          | Lista (filtros: status, unread, sla, search) |
| GET    | `/conversations/:id`                      | Detalhe + msgs + sugestão pendente + KB      |
| GET    | `/dashboard/sla`                          | Resumo SLA (counts + 10 mais críticas)       |
| POST   | `/conversations/:id/suggest`              | Regenera sugestão na última msg do comprador |
| POST   | `/conversations/:id/suggest/transform`    | `{text, tone}` mais_empatico/mais_objetivo   |
| POST   | `/conversations/:id/send`                 | `{text, suggestion_id?, action?}` ≤350 chars |
| POST   | `/conversations/:id/resolve`              | Marca conversation como resolvida            |
| GET    | `/knowledge/:product_id`                  | Lê KB do produto                             |
| PUT    | `/knowledge/:product_id`                  | Atualiza KB do produto                       |

### Variáveis de ambiente novas

Nenhuma obrigatória. Reusa:
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (LlmService global ou per-org)
- `ML_CLIENT_ID` / `ML_CLIENT_SECRET` (já configurados pra OAuth ML)

Opcional (dev):
- `DISABLE_ML_POSTSALE_SLA_WORKER=true` — desliga o cron de SLA
