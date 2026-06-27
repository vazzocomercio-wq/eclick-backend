-- ============================================================
-- Product OS — snapshot da câmera por impressora
-- O frame JPEG vai pro storage (product-os/cam/{printerId}.jpg); aqui só
-- carimbamos quando chegou o último, p/ o monitor saber que há imagem.
-- ============================================================
ALTER TABLE printer_status ADD COLUMN IF NOT EXISTS camera_at TIMESTAMPTZ;
