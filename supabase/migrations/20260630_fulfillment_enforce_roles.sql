-- F12 Fulfillment Sprint 2 — enforcement de papéis de operador (opt-in).
--
-- Quando true, exige que o usuário seja warehouse_operator com papel compatível
-- pra agir no CD (picker→separação, packer→conferência, supervisor/admin→tudo).
-- Modo ABERTO (qualquer membro da org) enquanto não houver operador cadastrado,
-- pra não trancar ninguém sem querer. OFF por padrão.

ALTER TABLE public.fulfillment_settings
  ADD COLUMN IF NOT EXISTS enforce_roles boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.fulfillment_settings.enforce_roles IS
  'Exige warehouse_operator com papel compatível pra agir no CD. Modo aberto se não há operador cadastrado. OFF por padrão.';
