-- F6: source_frame_path — caminho do PNG do último frame extraído via ffmpeg
-- pra usar como first_frame do próximo vídeo da chain.
--
-- Por que separar de source_image_id:
--   - source_image_id aponta pra row em creative_images (imagem de marketing)
--   - source_frame_path aponta direto pro PNG no Storage (não cria row em creative_images)
--   - Mantém separação: chain frames são utilitários internos, não confundir com
--     imagens aprovadas pelo usuário

ALTER TABLE creative_videos
  ADD COLUMN IF NOT EXISTS source_frame_path text;

COMMENT ON COLUMN creative_videos.source_frame_path IS
  'F6: storage path do PNG do último frame do vídeo anterior na chain. Usado como first_frame deste vídeo. Quando preenchido, ignora source_image_id.';
