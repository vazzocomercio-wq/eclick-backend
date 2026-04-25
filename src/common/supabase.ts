import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!

// SUPABASE_SECRET_KEY takes priority — it is the service_role (sb_secret_*) key.
// SUPABASE_SERVICE_ROLE_KEY is accepted as a fallback for Railway deployments
// that may have it set under that name.
const serviceRoleKey =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY

if (!serviceRoleKey) {
  console.error(
    '[supabase] FATAL: neither SUPABASE_SECRET_KEY nor SUPABASE_SERVICE_ROLE_KEY is set.' +
    ' Database writes will fail.',
  )
} else {
  const prefix = serviceRoleKey.substring(0, 24)
  const isServiceRole =
    serviceRoleKey.startsWith('sb_secret_') ||
    serviceRoleKey.startsWith('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  console.log(
    `[supabase] admin client initialised | key prefix: ${prefix}... | is service_role: ${isServiceRole}`,
  )
  if (!isServiceRole) {
    console.error(
      '[supabase] ERROR: key does NOT look like a service_role key (expected sb_secret_* or eyJhbG...).' +
      ' All RLS-protected queries will fail with "permission denied".' +
      ' Set SUPABASE_SECRET_KEY to the service_role key from Supabase → Settings → API.',
    )
  }
}

export const supabaseAdmin = createClient(
  supabaseUrl,
  serviceRoleKey!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)
