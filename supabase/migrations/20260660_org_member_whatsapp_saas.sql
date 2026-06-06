-- 20260660 — WhatsApp do membro do SaaS (operador) p/ alerta de tarefa URGENTE
--
-- Operadores da Operação de Cadastro = membros da Equipe do SaaS cuja org tem
-- o módulo 'active' ligado. O WhatsApp é cadastrado aqui (fonte da verdade);
-- ao despachar uma tarefa URGENTE, o SaaS dispara alerta no WhatsApp do operador
-- pelo canal grátis (Baileys). Aditivo/idempotente: NULL = sem alerta.

ALTER TABLE public.organization_members
  ADD COLUMN IF NOT EXISTS whatsapp_phone text;

COMMENT ON COLUMN public.organization_members.whatsapp_phone IS
  'WhatsApp do membro/operador (só dígitos/+) p/ alerta de tarefa urgente da Operação de Cadastro. NULL = sem alerta.';
