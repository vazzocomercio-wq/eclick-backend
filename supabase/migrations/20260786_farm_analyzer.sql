-- ============================================================
-- Analyzer 'farm' — falha de impressão da Print Farm, com fotos (FarmService.alertarComFotos).
-- 1. Libera 'farm' nos CHECKs de alert_routing_rules e alert_signals (mantém os anteriores).
-- 2. Regra padrão: 'farm' vai pra todo departamento com gestor ativo e verificado.
-- Idempotente.
-- ============================================================

ALTER TABLE alert_routing_rules
  DROP CONSTRAINT IF EXISTS alert_routing_rules_analyzer_check;
ALTER TABLE alert_routing_rules
  ADD CONSTRAINT alert_routing_rules_analyzer_check
  CHECK (analyzer = ANY (ARRAY[
    'compras','preco','estoque','margem','ads',
    'cross_intel','atendente_ia','ml','ia_saude','farm','*'
  ]));

DO $$
DECLARE has_check boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname='alert_signals' AND n.nspname='public'
      AND c.conname='alert_signals_analyzer_check'
  ) INTO has_check;
  IF has_check THEN
    EXECUTE 'ALTER TABLE alert_signals DROP CONSTRAINT alert_signals_analyzer_check';
    EXECUTE 'ALTER TABLE alert_signals ADD CONSTRAINT alert_signals_analyzer_check ' ||
      'CHECK (analyzer = ANY (ARRAY[''compras'',''preco'',''estoque'',''margem'',''ads'',''cross_intel'',''atendente_ia'',''ml'',''ia_saude'',''farm'',''*'']))';
  END IF;
END $$;

INSERT INTO alert_routing_rules (organization_id, department, analyzer, categories, min_score, enabled)
SELECT DISTINCT m.organization_id, m.department, 'farm', ARRAY[]::text[], 0, true
FROM alert_managers m
WHERE m.status = 'active' AND m.verified = true
  AND NOT EXISTS (
    SELECT 1 FROM alert_routing_rules r
    WHERE r.organization_id = m.organization_id
      AND r.department = m.department
      AND r.analyzer = 'farm'
  );
