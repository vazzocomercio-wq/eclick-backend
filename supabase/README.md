# Supabase — Migrations

Esta pasta contém as migrations de banco do projeto. As migrations estão divididas em dois conjuntos:

- **e-Click SaaS** (schema `public`, padrão `YYYYMMDD_*.sql`): as 28 migrations existentes do produto SaaS.
- **e-Click Active** (schema `active`, padrão `NNN_*.sql`): a partir de `001_foundation_schema.sql`.

> **Atenção:** o Supabase CLI executa migrations em ordem alfabética. O arquivo `001_foundation_schema.sql` ordena antes de qualquer `20260*.sql`, mas como ele cria um schema novo (`active`), não há colisão com `public`.

---

## Como rodar `001_foundation_schema.sql` no Supabase SQL Editor

### 1. Pré-requisitos (extensões)

A migration usa duas extensões que precisam estar habilitadas no projeto:

- `pgvector` — busca semântica em `active.knowledge_documents.embedding`
- `pg_cron` — job que marca tarefas em atraso a cada 15 minutos

No painel do Supabase:

1. Acesse **Database → Extensions** no menu lateral
2. Habilite `vector` (pgvector) e `pg_cron`

> A migration tem `CREATE EXTENSION IF NOT EXISTS`, mas o SQL Editor pode não ter privilégio para instalar extensões — habilitar pelo painel é mais seguro.

### 2. Executar a migration

1. Abra **SQL Editor** no painel do Supabase
2. Crie um novo query: **+ New query**
3. Cole o conteúdo completo de `migrations/001_foundation_schema.sql`
4. Clique em **Run** (ou `Ctrl+Enter`)

A execução leva ~5–15 segundos. Não deve haver erros se as extensões estiverem habilitadas.

### 3. Verificar

Rode no SQL Editor para confirmar que o schema foi criado:

```sql
-- Lista todas as tabelas do schema active
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'active'
ORDER BY table_name;
```

Esperado: 28 tabelas (incluindo as partições mensais de `messages` e `ai_interactions`).

```sql
-- Verifica que RLS está habilitado em todas
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'active'
ORDER BY tablename;
```

Esperado: `rowsecurity = true` em todas as tabelas principais.

```sql
-- Verifica que o cron job foi registrado
SELECT jobname, schedule, command
FROM cron.job
WHERE jobname = 'active-mark-overdue-tasks';
```

### 4. Bootstrap de uma nova organização

Depois da migration, para criar uma org com funil padrão e configurações de IA:

```sql
-- Substitua os UUIDs pelos reais
SELECT active.setup_new_organization(
  p_org_id            => 'UUID-DA-ORG',
  p_user_id           => 'UUID-DO-USUARIO-AUTH',
  p_org_name          => 'Nome da Empresa',
  p_user_display_name => 'Nome do Owner'
);
```

A função adiciona o usuário como `owner`, cria o pipeline "Funil Principal" com 6 estágios + Ganho/Perdido, e configura os feature flags de IA padrão.

---

## Estrutura criada por `001_foundation_schema.sql`

| Bloco | Tabelas |
|-------|---------|
| Identity & Access | `organizations`, `org_members`, `workspaces`, `api_keys` |
| Contacts | `companies`, `contacts`, `contact_timeline` |
| Channels | `channels`, `channel_webhooks` |
| Conversations | `conversations`, `messages` (particionada), `message_templates` |
| Pipelines | `pipelines`, `pipeline_stages`, `deals`, `deal_activities` |
| Tasks | `tasks` |
| Automations | `automations`, `automation_logs` |
| Knowledge | `knowledge_documents`, `products_catalog`, `response_templates` |
| AI & Analytics | `ai_interactions` (particionada), `ai_feature_settings`, `lead_scores`, `funnel_analytics`, `agent_performance` |
| Notifications | `notifications` |
| Views | `v_inbox`, `v_deal_board` |

Particionamento mensal cria 12 partições futuras (`messages_2026_05` … `messages_2027_04`) + uma partição `_default`. Em produção, agendar criação de novas partições antes do horizonte estourar.

---

## Rollback

Para desfazer (cuidado — apaga **todos os dados** de Active CRM):

```sql
DROP SCHEMA active CASCADE;
SELECT cron.unschedule('active-mark-overdue-tasks');
```

As extensões `pgvector` e `pg_cron` ficam, pois podem estar em uso por outras partes do sistema.
