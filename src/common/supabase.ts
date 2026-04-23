import { createClient } from '@supabase/supabase-js'

// Accept both naming conventions (Railway may use either)
const supabaseUrl = process.env.SUPABASE_URL!
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SECRET_KEY

if (!serviceRoleKey) {
  console.error(
    '[supabase] FATAL: neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_SECRET_KEY is set.' +
    ' Database writes will fail.',
  )
} else {
  const prefix = serviceRoleKey.substring(0, 20)
  const isServiceRole =
    serviceRoleKey.startsWith('sb_secret_') ||
    serviceRoleKey.startsWith('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  console.log(
    `[supabase] admin client initialised | key prefix: ${prefix}... | looks like service_role: ${isServiceRole}`,
  )
  if (!isServiceRole) {
    console.warn(
      '[supabase] WARNING: the key does NOT look like a service_role key.' +
      ' Inserts may fail with "permission denied".' +
      ' Set SUPABASE_SERVICE_ROLE_KEY to the service_role key from Supabase → Settings → API.',
    )
  }
}

export const supabaseAdmin = createClient(
  supabaseUrl,
  serviceRoleKey!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)
