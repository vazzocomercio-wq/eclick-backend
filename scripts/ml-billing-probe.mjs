#!/usr/bin/env node
/** Read-only: testa endpoints de FATURAMENTO/settlement do ML para achar
 *  os créditos (bônus Flex, reembolsos) que o /shipments/costs não traz. */
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
console.log('seller usado:', seller_id)

const tries = [
  `/billing/integration/monthly/periods?group=ML&document_type=BILL&offset=0&limit=3`,
  `/billing/integration/periods?group=MP&document_type=BILL&limit=3`,
  `/users/${seller_id}/mercadopago_account/balance`,
]
for (const p of tries) {
  try {
    const r = await fetch(`https://api.mercadolibre.com${p}`, { headers: { Authorization: `Bearer ${tok}`, 'x-version': '2' } })
    const txt = await r.text()
    console.log(`\n=== ${p} -> HTTP ${r.status} ===`)
    console.log(txt.slice(0, 1200))
  } catch (e) { console.log(`${p} ERRO ${e.message}`) }
  await new Promise(res => setTimeout(res, 200))
}
