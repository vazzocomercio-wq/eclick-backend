-- Cleanup de runs zumbis em ml_campaigns_sync_logs (status running > 15min
-- = processo morreu sem fechar a row). Espelha o pattern do
-- BackfillService.onApplicationBootstrap.
UPDATE public.ml_campaigns_sync_logs
SET status        = 'failed',
    error_message = 'Run órfã detectada — processo deve ter morrido (Railway restart, timeout, etc.)',
    completed_at  = now()
WHERE status = 'running'
  AND started_at < now() - interval '15 minutes';
