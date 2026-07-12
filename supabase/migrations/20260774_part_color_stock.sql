-- ============================================================
-- Product OS — COR como dimensão do estoque de peças prontas.
--
-- A PEÇA segue SEM cor (o mesmo arquivo imprime em qualquer filamento);
-- a cor nasce na OP (colorway/variante escolhida ao imprimir) e o estoque
-- de peças prontas passa a saber QUANTO HÁ DE CADA COR. Os totais
-- canônicos continuam em product_dev_part (stock_qty/reserved_qty) — o
-- saldo por cor é uma dimensão adicional (baldes), best-effort quando a
-- referência não declara cor (balde NULL = "sem cor definida").
-- ============================================================

-- movimento ganha a cor (auditoria + espelhamento reserva/consumo por balde)
alter table public.product_dev_part_movement
  add column if not exists cor_id uuid references public.sku_taxonomy(id);

-- montagem pode declarar o colorway que está montando
alter table public.assembly_order
  add column if not exists sku_variant_id uuid references public.product_dev_sku_variant(id);

-- baldes de saldo por cor
create table if not exists public.product_dev_part_color_stock (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  part_id         uuid not null references public.product_dev_part(id) on delete cascade,
  cor_id          uuid references public.sku_taxonomy(id),   -- NULL = sem cor definida
  stock_qty       numeric not null default 0,
  reserved_qty    numeric not null default 0,
  updated_at      timestamptz not null default now()
);
create index if not exists idx_pdpcs_org  on public.product_dev_part_color_stock(organization_id);
create index if not exists idx_pdpcs_part on public.product_dev_part_color_stock(part_id);
create unique index if not exists ux_pdpcs_part_cor   on public.product_dev_part_color_stock(part_id, cor_id) where cor_id is not null;
create unique index if not exists ux_pdpcs_part_nocor on public.product_dev_part_color_stock(part_id) where cor_id is null;

-- unicidade dos movimentos: reservar de 2 baldes de cor gera 2 linhas
-- (mesma peça/ref/tipo) -> a cor entra na chave
drop index if exists ux_pdpmov_ref;
create unique index if not exists ux_pdpmov_ref
  on public.product_dev_part_movement(part_id, reference_type, reference_id, movement_type,
    coalesce(cor_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where reference_id is not null;

-- RLS + GRANTs (tabela criada via RPC não herda default privileges)
alter table public.product_dev_part_color_stock enable row level security;
drop policy if exists product_dev_part_color_stock_select on public.product_dev_part_color_stock;
create policy product_dev_part_color_stock_select on public.product_dev_part_color_stock
  for select to authenticated
  using (organization_id in (select organization_id from organization_members where user_id = auth.uid()));
drop policy if exists product_dev_part_color_stock_modify on public.product_dev_part_color_stock;
create policy product_dev_part_color_stock_modify on public.product_dev_part_color_stock
  for all to authenticated
  using (organization_id in (select organization_id from organization_members where user_id = auth.uid()))
  with check (organization_id in (select organization_id from organization_members where user_id = auth.uid()));
grant all on table public.product_dev_part_color_stock to service_role;
grant select, insert, update, delete on table public.product_dev_part_color_stock to authenticated;
