-- Sessão 2026-05-19 (e-Click Saas 23) — Estoque unificado, Fase 2.
--
-- Majoração virtual por canal: alguns canais (ex: Shopee) exigem estoque
-- inflado pra elegibilidade de ofertas-relâmpago. virtual_markup é somado
-- à quantidade publicada NAQUELE canal. A decisão de pausar continua
-- olhando o estoque REAL — quando o real zera, o canal pausa mesmo com
-- markup (sem estoque fantasma na vitrine).
--
-- Dormente: default 0 = nenhum efeito hoje. Vira só quando a Shopee ligar.

ALTER TABLE public.channel_stock_distribution
  ADD COLUMN IF NOT EXISTS virtual_markup integer NOT NULL DEFAULT 0;
