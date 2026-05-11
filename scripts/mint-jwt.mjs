#!/usr/bin/env node
/**
 * Issue a one-shot access_token for an existing user via Supabase admin
 * generateLink + verifyOtp roundtrip. Service_role key only — no password needed.
 *
 * Uso:
 *   node scripts/mint-jwt.mjs vazzocomercio@gmail.com
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY

if (!SUPA_URL || !SVC_KEY || !ANON_KEY) {
  console.error('[mint-jwt] FATAL: SUPABASE_URL + service key + anon/publishable key são obrigatórios')
  process.exit(1)
}

const email = process.argv[2]
if (!email) {
  console.error('[mint-jwt] Uso: node scripts/mint-jwt.mjs <email>')
  process.exit(1)
}

const admin = createClient(SUPA_URL, SVC_KEY,  { auth: { autoRefreshToken: false, persistSession: false } })
const anon  = createClient(SUPA_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// 1. Gera magic link via admin (não envia email — apenas cria hashed_token)
const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email,
})
if (linkErr || !link?.properties?.hashed_token) {
  console.error('[mint-jwt] generateLink falhou:', linkErr?.message ?? 'sem hashed_token')
  process.exit(1)
}

// 2. Verifica o hashed_token usando anon key → troca por session com access_token
const { data: session, error: vErr } = await anon.auth.verifyOtp({
  token_hash: link.properties.hashed_token,
  type:       'magiclink',
})
if (vErr || !session?.session?.access_token) {
  console.error('[mint-jwt] verifyOtp falhou:', vErr?.message ?? 'sem access_token')
  process.exit(1)
}

// Output: só o JWT na stdout (fácil de capturar em var)
console.log(session.session.access_token)
console.error('[mint-jwt] ✓ JWT issued. Expira em:', new Date((session.session.expires_at ?? 0) * 1000).toISOString())
