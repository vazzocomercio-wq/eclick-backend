-- Sessão 2026-05-24 — BYOK Fase A passo 2: modo de chaves de IA por org.
--
-- 'own' (DEFAULT) = a org DEVE usar a própria chave de IA. Sem chave própria,
--   os recursos de IA bloqueiam (BYOK obrigatório — cliente paga com o crédito
--   dele, não com o da plataforma).
-- 'platform' = a org pode cair nas chaves globais da plataforma. Reservado
--   pra matriz e-Click / Vazzo.
--
-- O CredentialsService.resolveAiKey() respeita esse modo. Default 'own'
-- garante que TODA org nova (cliente) já entra em BYOK obrigatório.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS ai_keys_mode text NOT NULL DEFAULT 'own'
    CHECK (ai_keys_mode IN ('platform', 'own'));

-- Matriz e-Click / Vazzo continua usando as chaves da plataforma.
UPDATE public.organizations
SET ai_keys_mode = 'platform'
WHERE id = '4ef1aabd-c209-40b0-b034-ef69dcb66833';
