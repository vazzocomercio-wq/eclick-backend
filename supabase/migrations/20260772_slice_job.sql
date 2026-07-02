-- Product OS — fatiamento automático via Bambu Studio CLI (roda no PC da farm).
-- slice_job: fila de fatiamento que o agente puxa na telemetria; o resultado
-- (.gcode.3mf + tempo/gramas REAIS) volta pra versão do produto.
create table if not exists public.slice_job (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  version_id uuid not null references public.product_dev_version(id) on delete cascade,
  agent_id uuid references public.farm_agent(id),
  status text not null default 'pending',          -- pending | running | done | failed
  source_url text not null,
  source_name text,
  plate int not null default 1,
  machine_profile text not null default 'Bambu Lab A1 0.4 nozzle',
  process_profile text not null default '0.20mm Standard @BBL A1',
  filament_profile text not null default 'Bambu PLA Basic @BBL A1',
  result_url text,
  result_meta jsonb,
  error text,
  requested_by uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists idx_slice_job_org_status on public.slice_job(organization_id, status);
create index if not exists idx_slice_job_version on public.slice_job(version_id, created_at desc);

-- arquivo fatiado NÃO substitui o modelo original: coluna própria
alter table public.product_dev_version add column if not exists sliced_file_url text;

-- tabelas criadas via RPC não recebem default privileges
grant select, insert, update, delete on public.slice_job to service_role;
grant select, insert, update, delete on public.slice_job to postgres;
