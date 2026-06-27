-- Estado da luz da câmara/impressora (telemetria) para o botão LIGA/DESLIGA único.
alter table public.printer_status add column if not exists light_on boolean;
