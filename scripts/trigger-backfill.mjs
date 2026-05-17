#!/usr/bin/env node
// Dispara backfill manual via API REST autenticado com JWT do usuário admin.
// Uso: node scripts/trigger-backfill.mjs <days>
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
const USER_ID  = '60ad329d-c294-4ad7-b13b-7aaf4f5f76b6'
const days     = Number(process.argv[2] ?? 5)

if (!SUPA_URL || !SVC_KEY) { console.error('env missing'); process.exit(1) }

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

// Pega email do user pra usar generateLink
const { data: u, error: ue } = await admin.auth.admin.getUserById(USER_ID)
if (ue || !u?.user?.email) { console.error('getUserById:', ue?.message ?? 'no email'); process.exit(1) }
const email = u.user.email

// Gera magic link → access_token (não confirma, apenas pega session)
const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
if (le) { console.error('generateLink:', le.message); process.exit(1) }

// O magic link contém um hashed_token. Precisamos verificá-lo pra obter sessão.
const { data: session, error: se } = await admin.auth.verifyOtp({
  token_hash: link.properties.hashed_token,
  type: 'magiclink',
})
if (se || !session?.session?.access_token) { console.error('verifyOtp:', se?.message); process.exit(1) }

const jwt = session.session.access_token
console.log('[backfill] JWT obtido, disparando run-now days=' + days + '...')

const res = await fetch('https://api.eclick.app.br/sales-aggregator/run-now', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
  body:    JSON.stringify({ days }),
})
const body = await res.text()
console.log('[backfill] HTTP', res.status, body)
