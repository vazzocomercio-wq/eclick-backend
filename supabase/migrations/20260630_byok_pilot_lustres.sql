-- Sessão 2026-05-24 — BYOK piloto: bloquear SÓ a org "Lustres Online".
--
-- Decisão do lojista: por enquanto, apenas "Lustres Online" entra em BYOK
-- obrigatório (modo 'own') pra testar o fluxo de chave própria. Vazzo, Eslar
-- e qualquer org futura continuam nas chaves da plataforma (modo 'platform').
-- Default volta pra 'platform' (org nova entra conectada; flip pra BYOK em
-- massa depois = 1 ALTER).

ALTER TABLE public.organizations ALTER COLUMN ai_keys_mode SET DEFAULT 'platform';

-- Todos pra platform...
UPDATE public.organizations
SET ai_keys_mode = 'platform'
WHERE id <> 'b977240d-b941-4925-a8fc-5309044fb222';

-- ...exceto o piloto Lustres Online (BYOK obrigatório).
UPDATE public.organizations
SET ai_keys_mode = 'own'
WHERE id = 'b977240d-b941-4925-a8fc-5309044fb222';
