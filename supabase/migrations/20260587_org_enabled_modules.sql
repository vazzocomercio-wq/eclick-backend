-- Multi-tenant: módulos liberados por organização.
--
-- Cada organização passa a poder ter uma lista de módulos liberados. O
-- menu lateral do SaaS só mostra os módulos presentes nessa lista.
-- NULL = todos os módulos liberados (comportamento atual — não altera
-- nenhuma organização existente, ex.: Vazzo).
--
-- As chaves de módulo espelham as seções do Sidebar do frontend:
-- visaogeral, active, marketplace, compras, dropship, crm, producao,
-- loja, atendente-ia, ads, projeto, inteligencia, configuracoes.
-- (visaogeral e configuracoes são sempre visíveis — núcleo.)

alter table public.organizations
  add column if not exists enabled_modules text[];

comment on column public.organizations.enabled_modules is
  'Chaves de módulo liberadas pra esta org (espelham as seções do Sidebar). NULL = todos liberados.';
