-- 20260722_fulfillment_locations_coluna_setor.sql
-- Suporte a DOIS padrões de endereçamento (o cliente escolhe qual usar):
--   1) Coluna-Estante-Nível  → ex.: A1-N1  (Coluna A = setor/fila; Estante 1; Nível 1)
--        Coluna = letra estilo Excel (A,B,C… AA,AB…), INFINITA, representa um SETOR
--        (A=pendentes, B=arandelas…). Nome do setor opcional por coluna.
--   2) Rua-Estante-Nível-Posição → ex.: R02-E05-N3-P01
-- A tabela guarda as partes das DUAS formas (rua/posicao + coluna/setor); o `code` e o
-- `sequence` são montados conforme o padrão escolhido. A escolha fica em
-- fulfillment_settings.settings.address_scheme (sem migração nova).

ALTER TABLE public.warehouse_locations ADD COLUMN IF NOT EXISTS coluna text;
ALTER TABLE public.warehouse_locations ADD COLUMN IF NOT EXISTS setor  text;
-- rua/estante/nivel/posicao já existem (migração 20260721) — mantidos pro padrão 2.
