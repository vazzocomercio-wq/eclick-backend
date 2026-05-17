import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

// Pega user_id real do Vazzo via auth.users
const url = `${SUPA_URL.replace(/\/+$/, '')}/rest/v1/rpc/_admin_query_sql`
const r = await fetch(url, {
  method: 'POST',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql: `SELECT id, email FROM auth.users WHERE email = 'vazzocomercio@gmail.com' LIMIT 1` }),
})
console.log('User lookup:', JSON.stringify(await r.json(), null, 2))

// Test endpoint locally? Actually we can't get a valid Bearer token without OAuth flow.
// Instead, let's just check if there's any obvious issue.
