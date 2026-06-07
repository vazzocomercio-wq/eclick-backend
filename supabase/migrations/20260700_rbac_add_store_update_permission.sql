-- 20260700 — RBAC: adiciona a permissão `store.update` (faltava no seed)
--
-- BUG: ~90 endpoints de ESCRITA da loja (store-config, designer-v2/v3, cupons,
-- frete, fidelidade, cashback, bônus, afiliados, reviews, blog,
-- promotion-campaigns, store-automation, store-copilot, storefront,
-- storefront-variants, storefront-visualizer, banner-generator) usam
-- `@RequirePermission('store.update')`, mas o seed do RBAC (20260660) só criou
-- as granulares store.view/edit_design/publish/checkout_config — NENHUMA usada
-- pelos controllers. Resultado: toda escrita da loja dava HTTP 403 pra TODOS,
-- até o owner (a permissão não existia → ninguém podia tê-la).
--
-- FIX: cria `store.update` e concede aos templates owner/admin/manager/operator,
-- espelhando EXATAMENTE a lógica de grant do seed original (viewer não recebe,
-- pois action_type='update'). Idempotente — em prod a permissão já foi inserida
-- manualmente em 2026-06-07, então os ON CONFLICT tornam este migration no-op lá.

-- 1. Permissão
INSERT INTO public.permissions (key, name, module, action_type, description, display_order) VALUES
  ('store.update', 'Gerenciar loja', 'store', 'update',
   'Editar configurações, conteúdo, regras e checkout da loja própria.', 810)
ON CONFLICT (key) DO NOTHING;

-- 2. Grants nos templates (mesma estratégia do seed 20260660)
WITH p AS (SELECT id FROM public.permissions WHERE key = 'store.update')
-- owner/admin/manager/operator recebem (viewer não — só *.view)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, (SELECT id FROM p)
FROM public.roles r
WHERE r.is_template AND r.key IN ('owner','admin','manager','operator')
ON CONFLICT DO NOTHING;
