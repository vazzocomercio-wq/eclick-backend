-- AI-5: adiciona 'atendente_ia' ao enum de analyzers no Intelligence Hub.
-- Atendente IA emite signals (escalação, baixa confiança) que viram alertas
-- internos pra gestor — mesma pipeline dos outros analyzers (compras, preço,
-- estoque, margem, ads). Não tem cron próprio: AiResponderService chama o
-- bridge inline quando escalate/queue_for_human acontece.

-- alert_signals.analyzer
ALTER TABLE alert_signals DROP CONSTRAINT IF EXISTS alert_signals_analyzer_check;
ALTER TABLE alert_signals ADD CONSTRAINT alert_signals_analyzer_check
  CHECK (analyzer IN ('compras','preco','estoque','margem','ads','cross_intel','atendente_ia'));

-- alert_routing_rules.analyzer (inclui '*' wildcard)
ALTER TABLE alert_routing_rules DROP CONSTRAINT IF EXISTS alert_routing_rules_analyzer_check;
ALTER TABLE alert_routing_rules ADD CONSTRAINT alert_routing_rules_analyzer_check
  CHECK (analyzer IN ('compras','preco','estoque','margem','ads','cross_intel','atendente_ia','*'));
