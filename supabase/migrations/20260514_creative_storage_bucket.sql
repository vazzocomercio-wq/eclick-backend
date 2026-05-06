-- Sprint F6 — IA Criativo (bucket de storage)
--
-- Cria o bucket `creative` que estava sendo usado pelo pipeline de
-- imagens (creative-image-pipeline.service) e pelo upload do frontend
-- (creative/api.ts) sem nunca ter sido criado. Causava
-- "Bucket not found" no fluxo de criação de novo creative.
--
-- Bucket privado: leitura sempre via signed URL (TTL 24h pra preview
-- no front, 5min pra ops internas). Path: {orgId}/{...}.
--
-- Rollback:
--   DROP POLICY IF EXISTS "creative org select" ON storage.objects;
--   DROP POLICY IF EXISTS "creative org insert" ON storage.objects;
--   DROP POLICY IF EXISTS "creative org update" ON storage.objects;
--   DROP POLICY IF EXISTS "creative org delete" ON storage.objects;
--   DELETE FROM storage.buckets WHERE id = 'creative';

-- 1. Bucket privado (mesmo perfil de tamanho/mime que `produtos`)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'creative',
  'creative',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 2. Policies em storage.objects — primeiro segmento do path = org_id
--    Members da org podem CRUD paths da propria org. Service_role
--    bypassa RLS automaticamente, entao backend continua livre.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'creative org select'
  ) THEN
    CREATE POLICY "creative org select" ON storage.objects
      FOR SELECT USING (
        bucket_id = 'creative'
        AND (storage.foldername(name))[1]::uuid IN (
          SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'creative org insert'
  ) THEN
    CREATE POLICY "creative org insert" ON storage.objects
      FOR INSERT WITH CHECK (
        bucket_id = 'creative'
        AND (storage.foldername(name))[1]::uuid IN (
          SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'creative org update'
  ) THEN
    CREATE POLICY "creative org update" ON storage.objects
      FOR UPDATE USING (
        bucket_id = 'creative'
        AND (storage.foldername(name))[1]::uuid IN (
          SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'creative org delete'
  ) THEN
    CREATE POLICY "creative org delete" ON storage.objects
      FOR DELETE USING (
        bucket_id = 'creative'
        AND (storage.foldername(name))[1]::uuid IN (
          SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;
