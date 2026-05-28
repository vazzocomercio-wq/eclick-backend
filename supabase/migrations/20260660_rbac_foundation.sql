-- F17-B · RBAC Granular — fundação (schema + templates + catálogo + compat).
-- Sprint paralela à F17-A (gate de acesso). Não conflita.
--
-- Modelo: híbrido (5 templates fixos + custom por org).
-- Granularidade: por ação (`products.publish_ml`, `orders.refund`, …).
-- Templates = `roles` com `organization_id IS NULL AND is_template = true`.
-- Custom = `roles` com `organization_id` setado + `is_template = false`.
-- Usuário pode ter MÚLTIPLAS roles por org (aditivo) via `user_roles`.
--
-- ⚠️ Esta migration NÃO instrumenta endpoints com @RequirePermission ainda
--    (esse é o B3-B5 do plano). Aqui está só a fundação de dados + backfill
--    cosmético pra UI futura. RBAC continua DECORATIVO até a Wave de cobertura.

-- ─── 1. Permissions (catálogo global) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  module       text NOT NULL,
  action_type  text NOT NULL CHECK (action_type IN ('view','create','update','delete','publish','admin','custom')),
  display_order int NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS permissions_module_idx ON public.permissions(module);
CREATE INDEX IF NOT EXISTS permissions_action_idx ON public.permissions(action_type);

COMMENT ON TABLE public.permissions IS 'Catálogo global de permissions atômicas (key = "{module}.{action}"). Compartilhado entre todas as orgs — não duplicar.';
COMMENT ON COLUMN public.permissions.module IS 'Módulo lógico: products, orders, ads, social, stock, fiscal, fulfillment, store, crm, financeiro, telemetry, settings, integrations, team.';
COMMENT ON COLUMN public.permissions.action_type IS 'Categoria abstrata do verbo (view/create/update/delete/publish/admin/custom). Pra agrupamento em UI; checagem real é por `key`.';

-- ─── 2. Roles (templates + custom por org) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  description     text,
  is_template     boolean NOT NULL DEFAULT false,
  is_system       boolean NOT NULL DEFAULT false, -- protege templates contra DELETE
  display_order   int NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Templates têm org_id NULL; key UNIQUE entre templates.
  -- Custom roles: key UNIQUE dentro da org.
  CONSTRAINT roles_template_or_org CHECK (
    (is_template = true  AND organization_id IS NULL) OR
    (is_template = false AND organization_id IS NOT NULL)
  )
);
-- key UNIQUE para templates (org_id NULL)
CREATE UNIQUE INDEX IF NOT EXISTS roles_template_key_uniq
  ON public.roles(key) WHERE organization_id IS NULL;
-- key UNIQUE por org (não-templates)
CREATE UNIQUE INDEX IF NOT EXISTS roles_org_key_uniq
  ON public.roles(organization_id, key) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS roles_org_idx ON public.roles(organization_id);

COMMENT ON TABLE public.roles IS 'Templates de role (org_id NULL) + roles customizadas por org. Custom herda permissions de um template via INSERT INTO role_permissions, depois admin remove/adiciona.';

-- ─── 3. role_permissions (many-to-many) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id       uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS role_permissions_perm_idx ON public.role_permissions(permission_id);

COMMENT ON TABLE public.role_permissions IS 'Associação role↔permission. Aditiva: user com múltiplas roles soma as permissions.';

-- ─── 4. user_roles (atribuição user↔role no contexto da org) ─────────────────
CREATE TABLE IF NOT EXISTS public.user_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  granted_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_roles_user_org_idx ON public.user_roles(user_id, organization_id);
CREATE INDEX IF NOT EXISTS user_roles_role_idx     ON public.user_roles(role_id);

COMMENT ON TABLE public.user_roles IS 'Atribuição user↔role por org. User pode ter múltiplas roles na mesma org (aditivo). Role precisa pertencer à org ou ser template.';

-- ─── 5. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles       ENABLE ROW LEVEL SECURITY;

-- Catálogo de permissions é PÚBLICO (read-only via API; writes só service_role)
DROP POLICY IF EXISTS permissions_read ON public.permissions;
CREATE POLICY permissions_read ON public.permissions
  FOR SELECT TO authenticated USING (true);

-- Roles: SELECT pra templates (sempre) + roles da org do user
DROP POLICY IF EXISTS roles_read ON public.roles;
CREATE POLICY roles_read ON public.roles
  FOR SELECT TO authenticated USING (
    is_template = true
    OR organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid())
  );

-- role_permissions: leitura segue a regra de roles (filtra via role_id)
DROP POLICY IF EXISTS role_permissions_read ON public.role_permissions;
CREATE POLICY role_permissions_read ON public.role_permissions
  FOR SELECT TO authenticated USING (
    role_id IN (
      SELECT id FROM public.roles
      WHERE is_template = true
         OR organization_id IN (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid())
    )
  );

-- user_roles: user vê suas próprias atribuições; admins/owners da org veem todas da org
DROP POLICY IF EXISTS user_roles_read ON public.user_roles;
CREATE POLICY user_roles_read ON public.user_roles
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR organization_id IN (
      SELECT organization_id FROM public.organization_members
      WHERE user_id = auth.uid() AND role IN ('owner','admin')
    )
  );

-- Writes: APENAS service_role (backend orquestra via RBAC service futuro).
-- Por design, não expomos INSERT/UPDATE/DELETE em RLS — RLS-on+0-policies = deny-all
-- pra anon/authenticated; service_role BYPASSRLS continua funcionando.

-- GRANTs explícitos (não atrapalha service_role; restringe direto)
GRANT SELECT ON public.permissions      TO authenticated;
GRANT SELECT ON public.roles            TO authenticated;
GRANT SELECT ON public.role_permissions TO authenticated;
GRANT SELECT ON public.user_roles       TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.permissions      TO service_role;
GRANT INSERT, UPDATE, DELETE ON public.roles            TO service_role;
GRANT INSERT, UPDATE, DELETE ON public.role_permissions TO service_role;
GRANT INSERT, UPDATE, DELETE ON public.user_roles       TO service_role;

-- ─── 6. SEED — catálogo de permissions ──────────────────────────────────────
-- Convenção: key = `{module}.{action}`. Categorias gerais por módulo, com
-- ações específicas onde o nível de detalhe importa pro produto.
INSERT INTO public.permissions (key, name, module, action_type, description, display_order) VALUES
  -- Products (catálogo)
  ('products.view',              'Ver produtos',                   'products', 'view',    'Listar e abrir produtos do catálogo.', 110),
  ('products.create',            'Criar produto',                  'products', 'create',  'Cadastrar produto novo.', 111),
  ('products.update',            'Editar produto',                 'products', 'update',  'Alterar campos de produto existente.', 112),
  ('products.delete',            'Excluir produto',                'products', 'delete',  'Remover produto (soft delete).', 113),
  ('products.import',            'Importar planilha',              'products', 'create',  'Upload .xlsx/.csv de produtos.', 114),
  ('products.publish_ml',        'Publicar no Mercado Livre',      'products', 'publish', 'Criar/atualizar anúncio ML.', 120),
  ('products.publish_tiktok',    'Publicar TikTok Shop',           'products', 'publish', 'Publicar produto na TikTok Shop.', 121),
  ('products.publish_shopee',    'Publicar Shopee',                'products', 'publish', 'Publicar produto na Shopee.', 122),
  ('products.publish_store',     'Publicar na loja própria',       'products', 'publish', 'Tornar produto visível na vitrine.', 123),

  -- Stock
  ('stock.view',                 'Ver estoque',                    'stock',    'view',    'Ver saldo e movimentações.', 210),
  ('stock.adjust',               'Ajustar estoque manualmente',    'stock',    'update',  'Lançar movimentação manual (entrada/saída).', 211),
  ('stock.transfer',             'Transferir entre depósitos',     'stock',    'update',  'Mover saldo entre depósitos.', 212),

  -- Orders
  ('orders.view',                'Ver pedidos',                    'orders',   'view',    'Listar e abrir pedidos.', 310),
  ('orders.update_status',       'Atualizar status do pedido',     'orders',   'update',  'Marcar como faturado/enviado/cancelado.', 311),
  ('orders.refund',              'Reembolsar pedido',              'orders',   'custom',  'Disparar refund (afeta financeiro).', 312),
  ('orders.cancel',              'Cancelar pedido',                'orders',   'custom',  'Cancelar pedido (afeta marketplace).', 313),

  -- Fiscal
  ('fiscal.view',                'Ver NF-e/CT-e',                  'fiscal',   'view',    'Ver notas emitidas e status SEFAZ.', 410),
  ('fiscal.emit',                'Emitir NF-e',                    'fiscal',   'publish', 'Disparar emissão pra SEFAZ.', 411),
  ('fiscal.cancel',              'Cancelar NF-e',                  'fiscal',   'custom',  'Cancelar nota emitida.', 412),
  ('fiscal.manage_certificate',  'Gerenciar certificado A1',       'fiscal',   'admin',   'Subir/trocar certificado digital.', 413),

  -- Fulfillment / WMS
  ('fulfillment.view',           'Ver WMS',                        'fulfillment', 'view',    'Acessar painel de fulfillment.', 510),
  ('fulfillment.pick',           'Bipar separação',                'fulfillment', 'update',  'Executar pick na PWA.', 511),
  ('fulfillment.pack',           'Embalar e gerar etiqueta',       'fulfillment', 'publish', 'Gerar etiqueta ML e finalizar embalagem.', 512),
  ('fulfillment.return',         'Processar devolução',            'fulfillment', 'custom',  'Bipar devolução e reestocar.', 513),

  -- Ads (Meta/Google/ML Ads)
  ('ads.view',                   'Ver ADS',                        'ads',      'view',    'Ver campanhas e métricas.', 610),
  ('ads.create_campaign',        'Criar campanha',                 'ads',      'create',  'Criar campanha nova.', 611),
  ('ads.update_budget',          'Alterar orçamento',              'ads',      'update',  'Subir/baixar orçamento.', 612),
  ('ads.pause_resume',           'Pausar/retomar campanha',        'ads',      'update',  'Pausar ou retomar campanha.', 613),
  ('ads.spend',                  'Aprovar gasto extra',            'ads',      'custom',  'Disparar boost / aumentar orçamento acima do limite.', 614),

  -- Social AI
  ('social.view',                'Ver social',                     'social',   'view',    'Ver biblioteca de posts/reels.', 710),
  ('social.create_post',         'Criar post',                     'social',   'create',  'Gerar/editar post de social.', 711),
  ('social.create_reel',         'Criar reel/vídeo',               'social',   'create',  'Gerar reel via IA.', 712),
  ('social.publish',             'Publicar no Instagram/TikTok',   'social',   'publish', 'Postar conteúdo aprovado.', 713),
  ('social.approve',             'Aprovar conteúdo da fila',       'social',   'custom',  'Liberar peça da fila de aprovação.', 714),

  -- Store (vitrine)
  ('store.view',                 'Ver loja',                       'store',    'view',    'Ver editor da loja própria.', 810),
  ('store.edit_design',          'Editar design da loja',          'store',    'update',  'Alterar seções/blocos do tema.', 811),
  ('store.publish',              'Publicar loja',                  'store',    'publish', 'Publicar versão atual.', 812),
  ('store.checkout_config',      'Configurar checkout',            'store',    'admin',   'Editar provedores de pagamento.', 813),

  -- CRM (Active)
  ('crm.view',                   'Ver CRM',                        'crm',      'view',    'Acessar inbox/cards.', 910),
  ('crm.message',                'Responder no inbox',             'crm',      'create',  'Enviar mensagem em conversa.', 911),
  ('crm.manage_pipeline',        'Editar pipelines',               'crm',      'update',  'Criar/editar funis.', 912),
  ('crm.export_contacts',        'Exportar contatos',              'crm',      'custom',  'Baixar CSV de contatos (PII).', 913),

  -- Financeiro
  ('financeiro.view',            'Ver financeiro',                 'financeiro', 'view',    'Ver pedidos, recebíveis, custos.', 1010),
  ('financeiro.update_margin',   'Editar margem/markup',           'financeiro', 'update',  'Alterar painel de markup.', 1011),
  ('financeiro.reconcile',       'Conciliar',                      'financeiro', 'custom',  'Conciliar repasses do ML/Mercado Pago.', 1012),

  -- Telemetry / Insights
  ('telemetry.view',             'Ver insights de produto',        'telemetry', 'view',    'Ver dashboard de uso interno.', 1110),

  -- Integrations / credentials
  ('integrations.view',          'Ver integrações',                'integrations', 'view',  'Ver lista de integrações conectadas.', 1210),
  ('integrations.connect',       'Conectar integração',            'integrations', 'create','OAuth de marketplace/canal.', 1211),
  ('integrations.disconnect',    'Desconectar integração',         'integrations', 'delete','Remover conexão.', 1212),
  ('integrations.manage_keys',   'Gerenciar credenciais/API keys', 'integrations', 'admin', 'Editar segredos no cofre.', 1213),

  -- Settings (org)
  ('settings.view',              'Ver configurações da org',       'settings', 'view',    'Acessar /dashboard/configuracoes.', 1310),
  ('settings.update',            'Editar configurações da org',    'settings', 'update',  'Alterar nome/CNPJ/preferências.', 1311),
  ('settings.manage_modules',    'Habilitar/desabilitar módulos',  'settings', 'admin',   'Ligar/desligar módulos do plano.', 1312),

  -- Team (RBAC ops)
  ('team.view',                  'Ver equipe',                     'team',     'view',    'Listar members da org.', 1410),
  ('team.invite',                'Convidar membro',                'team',     'create',  'Enviar convite por email.', 1411),
  ('team.remove',                'Remover membro',                 'team',     'delete',  'Desligar member da org.', 1412),
  ('team.manage_roles',          'Gerenciar roles e permissões',   'team',     'admin',   'Criar/editar roles customizadas e atribuir users.', 1413),

  -- AI budget
  ('ai.view_usage',              'Ver uso de IA',                  'ai',       'view',    'Painel de consumo (telemetry-ai).', 1510),
  ('ai.manage_budget',           'Definir orçamento de IA',        'ai',       'admin',   'Alterar org_ai_budgets cap mensal.', 1511)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  module = EXCLUDED.module,
  action_type = EXCLUDED.action_type,
  display_order = EXCLUDED.display_order;

-- ─── 7. SEED — templates de role ────────────────────────────────────────────
INSERT INTO public.roles (organization_id, key, name, description, is_template, is_system, display_order) VALUES
  (NULL, 'owner',    'Owner',    'Dono da conta. Acesso total — não pode ser removido.',                              true, true, 10),
  (NULL, 'admin',    'Admin',    'Administrador. Tudo exceto faturamento, dados sensíveis e gestão de roles.',         true, true, 20),
  (NULL, 'manager',  'Manager',  'Gestor operacional. Vê tudo, executa publicações e ajustes, sem mexer em configs.',  true, true, 30),
  (NULL, 'operator', 'Operator', 'Operador. Executa o dia-a-dia (cadastro, pick/pack, mensagens, publicações).',       true, true, 40),
  (NULL, 'viewer',   'Viewer',   'Somente leitura. Vê painéis e relatórios, sem alterar nada.',                        true, true, 50)
ON CONFLICT DO NOTHING;

-- ─── 8. SEED — role_permissions (mapping dos templates) ─────────────────────
-- Estratégia: viewer = todos os *.view. Operator = viewer + create/update/publish básicos.
-- Manager = operator + delete + refund/cancel/spend. Admin = manager + integrações/team.
-- Owner = TODAS as permissions.

WITH
  tpl AS (
    SELECT id, key FROM public.roles WHERE is_template = true
  ),
  perms AS (
    SELECT id, key, action_type, module FROM public.permissions
  )

-- Owner: TODAS
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT (SELECT id FROM tpl WHERE key='owner'), p.id FROM perms p
ON CONFLICT DO NOTHING;

-- Admin: tudo EXCETO settings.manage_modules + integrations.manage_keys + team.manage_roles + ai.manage_budget + fiscal.manage_certificate
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT (SELECT id FROM public.roles WHERE key='admin' AND is_template), p.id
FROM public.permissions p
WHERE p.key NOT IN ('settings.manage_modules','integrations.manage_keys','team.manage_roles','ai.manage_budget','fiscal.manage_certificate')
ON CONFLICT DO NOTHING;

-- Manager: ações de operação + aprovações de gasto/refund/cancel; SEM team.* (exceto view) e SEM integrations writes
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT (SELECT id FROM public.roles WHERE key='manager' AND is_template), p.id
FROM public.permissions p
WHERE p.action_type IN ('view','create','update','publish')
   OR p.key IN ('orders.refund','orders.cancel','ads.spend','social.approve','fulfillment.return','financeiro.reconcile')
ON CONFLICT DO NOTHING;

-- Operator: view + create/update/publish do dia-a-dia; SEM delete, SEM custom (refund/cancel/spend), SEM admin
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT (SELECT id FROM public.roles WHERE key='operator' AND is_template), p.id
FROM public.permissions p
WHERE p.action_type IN ('view','create','update','publish')
  AND p.module NOT IN ('settings','integrations','team','ai','fiscal')
  -- Operator não emite NF-e nem mexe em settings/integrations/team/ai. Vê telemetria, financeiro, etc.
ON CONFLICT DO NOTHING;

-- Viewer: somente *.view
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT (SELECT id FROM public.roles WHERE key='viewer' AND is_template), p.id
FROM public.permissions p
WHERE p.action_type = 'view'
ON CONFLICT DO NOTHING;

-- ─── 9. COMPAT — backfill user_roles baseado em organization_members.role ───
-- Mapeamento:
--   organization_members.role = 'owner'  → template 'owner'
--   organization_members.role = 'admin'  → template 'admin'
--   organization_members.role = 'member' → template 'operator'  (sem viewer; viewer é opt-in)
-- Idempotente via UNIQUE (user_id, org_id, role_id).

INSERT INTO public.user_roles (user_id, organization_id, role_id, granted_by)
SELECT
  om.user_id,
  om.organization_id,
  r.id,
  NULL
FROM public.organization_members om
JOIN public.roles r
  ON r.is_template = true
 AND r.key = CASE om.role
               WHEN 'owner'  THEN 'owner'
               WHEN 'admin'  THEN 'admin'
               WHEN 'member' THEN 'operator'
               ELSE NULL
             END
WHERE r.key IS NOT NULL
ON CONFLICT (user_id, organization_id, role_id) DO NOTHING;

COMMENT ON TABLE public.user_roles IS 'Atribuição user↔role por org. Backfill 2026-05-28 mapeou owner/admin/member legacy pros templates owner/admin/operator. RBAC backend ainda DECORATIVO — endpoints serão instrumentados na Wave seguinte.';
