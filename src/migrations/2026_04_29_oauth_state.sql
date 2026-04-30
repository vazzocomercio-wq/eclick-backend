-- Sprint F5-2 / Batch 1.5 — OAuth state storage pra PKCE flow.
--
-- Cada chamada de /canva/oauth/start gera state + code_verifier aleatórios
-- (96 bytes base64url cada) e persiste aqui. /callback lê o row pelo state
-- (o único campo que vem na URL após user autorizar), validando que:
--   - Existe (CSRF defense — state desconhecido = ataque)
--   - Não foi consumed ainda (one-shot, replay protection)
--   - Não expirou (TTL 10min, suficiente pro user clicar approve)
-- Após uso bem-sucedido, marca consumed=true. Cron limpa rows antigas.
--
-- Tabela genérica pra suportar outros providers no futuro (Google, Meta, etc).
-- Por enquanto CHECK lista só 'canva'.
--
-- Rollback:
--   DROP TABLE IF EXISTS oauth_state;

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid,
  provider        text NOT NULL CHECK (provider IN ('canva')),
  state           text NOT NULL UNIQUE,
  code_verifier   text NOT NULL,
  redirect_to     text,                -- onde redirecionar após callback (opcional)
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_state_state_idx
  ON oauth_state (state)
  WHERE consumed = false;

CREATE INDEX IF NOT EXISTS oauth_state_expires_idx
  ON oauth_state (expires_at);

ALTER TABLE oauth_state ENABLE ROW LEVEL SECURITY;
GRANT ALL ON oauth_state TO service_role;

COMMIT;
