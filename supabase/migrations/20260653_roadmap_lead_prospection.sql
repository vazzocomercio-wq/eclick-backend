-- Roadmap — registra a fase F14 "Prospecção Ativa de Leads" (B2B + B2C) + items.
-- Idempotente: phases ON CONFLICT (org,num) DO NOTHING; items WHERE NOT EXISTS.
-- Módulo futuro (planned). Design detalhado: memória project_lead_prospection.md.

INSERT INTO roadmap_phases (organization_id, num, label, sub, status, pct, sort_order)
VALUES
  ('4ef1aabd-c209-40b0-b034-ef69dcb66833','F14','Prospecção Ativa de Leads',
   'B2B + B2C: discovery (Receita/CNPJ, Google Places, sales-intel, CPF licenciado), entity resolution, ICP scoring IA, sinais de intenção (Ad Library/Radar/vagas), cadência multicanal',
   'planned', 0, 14)
ON CONFLICT (organization_id, num) DO NOTHING;

DO $$
DECLARE
  v_org uuid := '4ef1aabd-c209-40b0-b034-ef69dcb66833';
  p_id  uuid;
BEGIN
  SELECT id INTO p_id FROM roadmap_phases WHERE organization_id = v_org AND num = 'F14';
  INSERT INTO roadmap_items (organization_id, phase_id, label, status, priority)
  SELECT v_org, p_id, x.label, x.status, x.priority FROM (VALUES
    ('Fundação: schema + abstração de fontes (multi-tenant)',                'planned', 0),
    ('Discovery PJ — Receita/CNPJ (sócios, CNAE, porte)',                    'planned', 0),
    ('Discovery PJ — Google Places (prospecção local)',                     'planned', 0),
    ('Discovery PJ — sales-intel BR (Econodata/Speedio)',                   'planned', 0),
    ('Discovery PF — provedores licenciados de CPF',                        'planned', 0),
    ('Enriquecimento + entity resolution + dedupe',                         'planned', 0),
    ('Ponte PJ->PF via QSA (sócio vira decisor)',                           'planned', 0),
    ('ICP scoring com IA (aderência por produto)',                          'planned', 0),
    ('Mensagem de abordagem IA (DOR/SOLUÇÃO/BENEFÍCIO)',                    'planned', 0),
    ('Sinais de intenção (Meta Ad Library + Radar + vagas + Reclame Aqui)', 'planned', 0),
    ('Push pro CRM + cadência multicanal (WA/email/LinkedIn)',              'planned', 0),
    ('LinkedIn via provider compliant',                                     'planned', 0),
    ('Loop de conversão (feedback p/ o scoring)',                           'planned', 0)
  ) AS x(label, status, priority)
  WHERE NOT EXISTS (SELECT 1 FROM roadmap_items WHERE phase_id = p_id AND label = x.label);
END $$;
