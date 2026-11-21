-- ============================================================
-- Analyzer 'ia_saude' — vigia da IA do e-Click (IaSaudeWatchService).
-- 1. Libera o valor 'ia_saude' nos CHECKs de alert_routing_rules e alert_signals.
-- 2. Regra de roteamento padrão: 'ia_saude' vai pra TODO departamento que já
--    tem gestor ativo e verificado na org (IA parada afeta todo mundo, e a
--    regra 'diretoria' '*' sozinha não entrega quando a org não tem gestor de
--    diretoria — caso da Vazzo em 21/11/2026).
-- Idempotente.
-- ============================================================

ALTER TABLE alert_routing_rules
  DROP CONSTRAINT IF EXISTS alert_routing_rules_analyzer_check;
ALTER TABLE alert_routing_rules
  ADD CONSTRAINT alert_routing_rules_analyzer_check
  CHECK (analyzer = ANY (ARRAY[
    'compras','preco','estoque','margem','ads',
    'cross_intel','atendente_ia','ml','ia_saude','*'
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
      'CHECK (analyzer = ANY (ARRAY[''compras'',''preco'',''estoque'',''margem'',''ads'',''cross_intel'',''atendente_ia'',''ml'',''ia_saude'',''*'']))';
  END IF;
END $$;

INSERT INTO alert_routing_rules (organization_id, department, analyzer, categories, min_score, enabled)
SELECT DISTINCT m.organization_id, m.department, 'ia_saude', ARRAY[]::text[], 0, true
FROM alert_managers m
WHERE m.status = 'active' AND m.verified = true
  AND NOT EXISTS (
    SELECT 1 FROM alert_routing_rules r
    WHERE r.organization_id = m.organization_id
      AND r.department = m.department
      AND r.analyzer = 'ia_saude'
  );
