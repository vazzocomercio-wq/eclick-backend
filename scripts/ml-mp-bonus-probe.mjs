#!/usr/bin/env node
/** Read-only: tenta achar o "Bônus por envio" via API — payment detail (MP) e
 *  variações de billing. Confirma se é capturável sem escopo MP extra. */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config as dotenv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv({ path: path.resolve(here, '..', '.env') })
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)
const ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const { data: conns } = await supa.from('ml_connections').select('seller_id, access_token').eq('organization_id', ORG)
const { seller_id, access_token: tok } = conns[0]

// payment_id da tela 3 (pagamento aprovado #156291306139)
const PAYMENT = '156291306139'
const tries = [
  `/v1/payments/${PAYMENT}`,
  `/billing/integration/periods/key/2026-06-01/group/MP/details?document_type=BILL&offset=0&limit=3`,
  `/users/${seller_id}/mercadopago_account/settlement_report/list`,
  `/v1/account/release_report`,
]
for (const p of tries) {
  try {
    const r = await fetch(`https://api.mercadolibre.com${p}`, { headers: { Authorization: `Bearer ${tok}`, 'x-version': '2' } })
    const txt = await r.text()
    console.log(`\n=== ${p}\n--> HTTP ${r.status} ===`)
    console.log(txt.slice(0, 1400))
  } catch (e) { console.log(`${p} ERRO ${e.message}`) }
  await new Promise(s => setTimeout(s, 400))
}
