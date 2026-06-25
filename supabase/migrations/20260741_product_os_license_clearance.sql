-- ============================================================
-- Product OS — liberação de licença (Peça 2: porteiro)
-- O veredito de licença (Peça 1) deixa de só informar e passa a BLOQUEAR a
-- publicação de produtos importados cuja licença não permite remodelar+vender
-- (não-verde). O override abaixo destrava quando o lojista adquire licença
-- comercial ou é autorizado pelo criador — registrando quem/quando/por quê.
-- Aditivo: 4 colunas em product_dev.
-- ============================================================
ALTER TABLE product_dev
  ADD COLUMN IF NOT EXISTS license_cleared       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS license_clearance_note TEXT,
  ADD COLUMN IF NOT EXISTS license_cleared_by    UUID,
  ADD COLUMN IF NOT EXISTS license_cleared_at    TIMESTAMPTZ;
