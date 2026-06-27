-- ========================================================================
-- Roadmap update 2026-06-27 — Product OS (Fábrica Digital de Produtos 3D)
--
-- Cria a fase F23 "Product OS" no roadmap da Vazzo capturando:
--   (a) a fundação JÁ EM PROD (Fases 1-9 + farm A/B/C + multi-fonte + peças)
--       como itens 'done';
--   (b) o roadmap de melhorias derivado da auditoria + benchmark mundial
--       (SimplyPrint / Printago / AutoFarm3D / Obico / Slant3D / MES-PLM),
--       como itens 'new' (Tier 1) e 'planned' (Tier 2/3), com notas de
--       implementação.
--
-- Idempotente: fase por (num+org), itens por (phase+label).
-- ========================================================================

DO $$
DECLARE
  org_id  uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833'::uuid;
  p_id    uuid;
BEGIN
  -- ── Fase F23 Product OS (cria se não existir) ──
  SELECT id INTO p_id FROM roadmap_phases WHERE num='F23' AND organization_id=org_id LIMIT 1;
  IF p_id IS NULL THEN
    INSERT INTO roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
    VALUES (org_id, 'F23', 'Product OS — Fábrica Digital de Produtos 3D',
            'Ideia → projeto → produção → venda. Farm Bambu ao vivo, custo real, peças+montagem, multi-fonte. Roadmap de melhorias pós-auditoria mundial.',
            'wip', 0, 23)
    RETURNING id INTO p_id;
  END IF;

  -- ── Itens DONE — fundação já em produção ──
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority, notes)
  SELECT org_id, p_id, x.label, x.status, x.priority, x.notes
  FROM (VALUES
    ('Ciclo de vida do produto (kanban ideia→briefing→modelagem→protótipo→aprovado→publicado→monitorando)', 'done', 0,
     'Tabela product_dev + drawer com abas. Drag-and-drop @dnd-kit.'),
    ('Briefing técnico por IA (DFM textual p/ Bambu 256³)', 'done', 0,
     'Feature product_os_briefing (Sonnet, jsonMode): módulos/paredes/orientação/originalidade.'),
    ('Import multi-fonte por URL (MakerWorld + Thingiverse + Cults3D)', 'done', 0,
     'Registry de providers; pré-preenche product_dev + 1ª versão (peso/tempo/material).'),
    ('Porteiro de licença (bloqueia publicar modelo não-comercial)', 'done', 0,
     'licenseVerdict verde/amarelo/vermelho; gate em publishToCatalog; override com clearance.'),
    ('Radar de campeões (watchlist + criadores + em alta + alerta de novidades)', 'done', 0,
     'Champion Score por velocidade; cron diário; digest WhatsApp via Active bridge.'),
    ('Versões CAD + parser .3mf/G-code (peso/tempo/material/bbox)', 'done', 0,
     'parse-3mf via fflate lê slice_info.config + plate_*.json (dimensões).'),
    ('Peças separadas + linha de montagem + plano de pratos', 'done', 0,
     'product_dev_part (estoque de semi-acabado) + assembly_order; IA sugere peças; nesting por prato.'),
    ('Custo: BOM + WAC vivo + estimado×real + preço por canal', 'done', 0,
     'Custo médio ponderado dinâmico; taxas all-in reais (ML/Shopee/TikTok/loja).'),
    ('Import de NF-e de insumo (XML determinístico + PDF via IA)', 'done', 0,
     'fast-xml-parser + feature nfe_pdf_extract; dedupe fornecedor por CNPJ; recalcula WAC.'),
    ('Ordens de produção + jobs + ledger de insumo (reserva/consumo)', 'done', 0,
     'Máquina de estados fila→imprimindo→…→disponível; protótipo vs produção; idempotente.'),
    ('Parque: payback ledger + lucro por hora de impressora + analytics', 'done', 0,
     'KPI correto = contribuição÷horas (gargalo=tempo de máquina); confiabilidade por máquina.'),
    ('Rastreio de filamento por rolo/bandeja AMS (consumo do rolo certo)', 'done', 0,
     'printer_loaded_filament; busca/scan por SKU+barcode; baixa do rolo montado.'),
    ('Farm ao vivo: agente MQTT local + telemetria 5s + câmera + comandos', 'done', 0,
     'A1 da Vazzo conectada; pause/resume/stop/luz; câmera TLS 6000; auto-fechamento + scheduler por R$/h.'),
    ('Painel da Fábrica: overview + plano de produção + rentabilidade', 'done', 0,
     'Payback geral capado por impressora; plano guloso por demanda 30d; ranking por R$/hora.')
  ) AS x(label, status, priority, notes)
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap_items i WHERE i.phase_id = p_id AND i.label = x.label
  );

  -- ── Itens NEW — Tier 1 (alto impacto, aproveita ativos existentes) ──
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority, notes)
  SELECT org_id, p_id, x.label, x.status, x.priority, x.notes
  FROM (VALUES
    ('[T1] Detecção de falha por IA com auto-pause (spaghetti/1ª camada)', 'new', 2,
     'GAP nº1 mundial (Obico/SimplyPrint/AutoFarm têm). Já temos câmera + canal de comando. (A) Nativo: ligar flag xcam.xcam_control_set via MQTT no agente; ler spaghetti_detector/halt_print_sensitivity no pushall → enfileira pause + alerta WhatsApp. (B) Agnóstico: rodar visão sobre os frames JPEG que já chegam em /farm/camera, score + sensibilidade + auto-pause. Vira KPI de taxa-de-falha MEDIDA (hoje é buffer chutado).'),
    ('[T1] Make-to-order: pedido real da loja → ordem de produção automática', 'new', 2,
     'DIFERENCIAL inatingível pelos concorrentes — somos donos dos pedidos (ML/Shopee/TikTok/loja própria já no e-Click). Printago/SimplyPrint puxam de Shopify/Etsy; nós puxamos do estoque unificado. Pedido de SKU 3D com estoque baixo → cria/sugere production_order, entra na fila, auto-close credita estoque. Fecha loop vendi→produzi→repus sem digitar. Liga em project_pedidos_multicanal + project_estoque_unificado.'),
    ('[T1] Scheduler de capacidade finita (Gantt + prazo) + auto-dispatch + matching por filamento', 'new', 2,
     'Hoje o scheduler só SUGERE por R$/h. Falta: (1) prazo de entrega real (Gantt: "6 ordens, 4 máquinas, pronto terça 14h"); (2) matching multi-critério usando o filamento carregado que já rastreamos (cor/material/bandeja AMS — não mandar job preto pra máquina com rolo branco); (3) auto-dispatch (scheduler aciona sendOrderToPrinter, não só seta printer_id). Com Swapmod na A1 vira lights-out real.')
  ) AS x(label, status, priority, notes)
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap_items i WHERE i.phase_id = p_id AND i.label = x.label
  );

  -- ── Itens PLANNED — Tier 2 (manufatura madura, diferencial técnico) ──
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority, notes)
  SELECT org_id, p_id, x.label, x.status, x.priority, x.notes
  FROM (VALUES
    ('[T2] Gate de DFM/printabilidade automático (regras numéricas) + auto-fix', 'planned', 1,
     'Xometry/Fictiv só APONTAM o problema; nós GERAMOS a geometria (repo vazzo-produtos-3d, manifold3d+numpy) → podemos CORRIGIR. Codificar design-rules do Hubs por processo (parede ≥0,8mm FDM, overhang ≤45°, dreno ≥3,5mm) como gate 2 níveis: Warning (revisa) vs Failure (bloqueia fila). Auto-fix: engrossar via offset, reorientar p/ cortar suporte, recotar. Ninguém faz auto-fix porque ninguém mais gera o modelo.'),
    ('[T2] OEE por impressora (Disponibilidade × Performance × Qualidade)', 'planned', 1,
     'Promover analytics atual (sucesso/horas) a OEE formal por máquina = número que aponta onde agir. Disponibilidade (clog/jam/manutenção/filament-out), Performance (velocidade real vs ideal, restarts), Qualidade (first-pass-good vs warp/layer-shift). World-class = 85%.'),
    ('[T2] SPC + Cpk em dimensões críticas (control chart na qualidade)', 'planned', 1,
     'Transformar o checklist de qualidade em control chart: pega bico gasto / mesa desnivelada / filamento úmido ANTES do refugo. p-chart de taxa de falha por impressora flagra máquina indo embora. Cpk ≥ 1,33 certifica peça funcional contra tolerância.'),
    ('[T2] Release imutável "Rev A" + ECO leve (effectivity/disposition)', 'planned', 1,
     'Do Onshape/Arena: marcar versão como Released Rev A (imutável, ÚNICA que o farm pode imprimir → acaba "qual .3mf imprimimos?"). Mudança de design vira ECO com effectivity (a partir de qual pedido a nova rev vale) e disposition do estoque atual (use-as-is/scrap/relabel).')
  ) AS x(label, status, priority, notes)
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap_items i WHERE i.phase_id = p_id AND i.label = x.label
  );

  -- ── Itens PLANNED — Tier 3 (refinos de inteligência + automação física) ──
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority, notes)
  SELECT org_id, p_id, x.label, x.status, x.priority, x.notes
  FROM (VALUES
    ('[T3] Forecast Holt-Winters → make-to-stock de campeões em horas ociosas', 'planned', 0,
     'Pré-imprimir best-sellers em horas ociosas usando suavização exponencial com sazonalidade (SKUs de presente/feriado). Suaviza a fila e protege prazo. Evolui o plano-guloso-por-30d atual.'),
    ('[T3] Radar por BOOST + qualidade de apresentação + Programa Exclusivo MakerWorld', 'planned', 0,
     'MakerWorld mudou o sinal de campeão de download → BOOST em 2025 (1/semana, $1 cada, dado por quem realmente imprime). Rankear por boost + qualidade de apresentação (fotos/profile verificado/instruções) prediz monetização melhor. Programa Exclusivo ($0,066/ponto, +25%, saque $100) = receita direta dos designs próprios da Vazzo.'),
    ('[T3] Lights-out físico: auto-ejeção Swapmod (A1) + auto-start do próximo job', 'planned', 0,
     'Swapmod = troca de placa 100% mecânica na A1 por puro G-code (sem hack de firmware, custo baixo) — a A1 que já temos. Loop fechado: detecta fim → ejeta → próximo job da fila sem operador. AutoFarm3D/Slant3D/SimplyPrint+JobOx são a referência. ⚠️ navegar o Authorization System da Bambu (controle local frágil — mirar Developer Mode/SDK oficial).')
  ) AS x(label, status, priority, notes)
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap_items i WHERE i.phase_id = p_id AND i.label = x.label
  );

  -- ── Recalcula pct da fase ──
  UPDATE roadmap_phases p SET
    pct = (
      SELECT GREATEST(0, LEAST(100, ROUND(100.0 *
        COUNT(*) FILTER (WHERE i.status = 'done') / NULLIF(COUNT(*), 0)
      )::int))
      FROM roadmap_items i WHERE i.phase_id = p.id
    ),
    updated_at = now()
  WHERE p.id = p_id;

  RAISE NOTICE 'Roadmap F23 Product OS atualizado: phase=%', p_id;
END $$;
