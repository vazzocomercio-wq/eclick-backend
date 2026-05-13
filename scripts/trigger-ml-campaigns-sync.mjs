#!/usr/bin/env node
/** Dispara POST /ml-campaigns/sync autenticado como Vazzo admin. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
const USER_ID  = '60ad329d-c294-4ad7-b13b-7aaf4f5f76b6'

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

const { data: u } = await admin.auth.admin.getUserById(USER_ID)
const email = u?.user?.email
if (!email) { console.error('user sem email'); process.exit(1) }

const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
const { data: session } = await admin.auth.verifyOtp({
  token_hash: link.properties.hashed_token,
  type: 'magiclink',
})
const jwt = session.session.access_token

console.log('[sync] disparando POST /ml-campaigns/sync (sem seller_id = todas as contas)...')
const res = await fetch('https://api.eclick.app.br/ml-campaigns/sync', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
})
const body = await res.text()
console.log('[sync] HTTP', res.status, body)
