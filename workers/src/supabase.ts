import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Singleton do client Supabase com service_role.
 *
 * No SaaS o schema é o default `public` (NÃO `active` — isso é o monorepo
 * separado). O worker faz operações privilegiadas (UPDATE em channels.credentials,
 * DELETE de canais pending órfãos) que bypassam RLS via service_role.
 */
function buildClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios no workers/.env')
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!_client) _client = buildClient()
  return _client
}
