-- Prod3d — alerta de impressora pausada/erro via WhatsApp.
-- O vigia local (MQTT da Bambu, LAN) chama POST /prod3d/alerta-impressora com
-- a watchdog_key; o backend manda WhatsApp pro numero configurado.

ALTER TABLE public.prod3d_config
  ADD COLUMN IF NOT EXISTS alerta_whatsapp text,
  ADD COLUMN IF NOT EXISTS watchdog_key uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_prod3d_config_watchdog
  ON public.prod3d_config(watchdog_key);
