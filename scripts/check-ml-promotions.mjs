#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY
const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } })

const SELLER_ID = 2290161131

const { data: c } = await admin
  .from('ml_connections')
  .select('access_token')
  .eq('seller_id', SELLER_ID)
  .maybeSingle()

if (!c?.access_token) { console.error('sem token'); process.exit(1) }

const r = await fetch(
  `https://api.mercadolibre.com/seller-promotions/promotions?app_version=v2`,
  { headers: { Authorization: `Bearer ${c.access_token}` } },
)
console.log('HTTP', r.status)
const text = await r.text()
let body
try { body = JSON.parse(text) } catch { body = text }
console.log('keys:', body && typeof body === 'object' ? Object.keys(body).join(', ') : 'string')
console.log('preview:', JSON.stringify(body).slice(0, 800))
