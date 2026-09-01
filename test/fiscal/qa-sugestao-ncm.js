// Rodar: npx tsc -p tsconfig.build.json && node test/fiscal/qa-sugestao-ncm.js
// QA da sugestão por NOME. Só vale se REPROVA os casos ruins que a auditoria
// achou e APROVA os bons — teste que passa nos dois não testa nada.
const fs = require('fs')
for (const l of fs.readFileSync('C:/Users/ECLICK 1/eclick-backend/.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l.trim())
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { FulfillmentFiscalService } = require('../../dist/modules/fulfillment/fulfillment-fiscal.service')
const { CompositionService } = require('../../dist/modules/composition/composition.service')
const ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'

// verdade de campo apurada na auditoria manual + fontes oficiais
const DEVE_SUGERIR = [
  { sku: 'VZ-11030805', ncm: '39249000', nota: 'porta-cotonetes = toucador' },
  { sku: 'VZ-15010404', ncm: '39241000', nota: 'porta-talheres = cozinha' },
  { sku: 'VZ-13011003-60', ncm: '39249000', nota: 'porta-escova = toucador' },
  { sku: 'VZ-06010104', ncm: '39249000', nota: 'bandeja penteadeira = toucador' },
  { sku: 'KIT-2UN-FSD80WB', ncm: '84145190', nota: 'kit de ventilador herda do PROPRIO ventilador, nao da categoria' },
  { sku: 'KIT-10UN-E27GY', ncm: '85395200', nota: 'kit de lampada herda da lampada' },
]
const NAO_PODE_SUGERIR = [
  { sku: 'KIT-3UN-202391/BEGE', errado: '94052900', nota: 'banquinho plastico herdou de ABAJUR infantil' },
  { sku: 'KIT-2UN-FSD80WB', errado: '94051190', nota: 'ventilador NAO e luminaria (categoria VENTILADOR DE TETO tem 8 plafons)' },
  { sku: 'VZ-11031004-60', errado: '39241000', nota: 'pote de banheiro herdou de POTE DE VIDRO de cozinha' },
  { sku: '0343', errado: '39249000', nota: 'cesto de roupa dobravel herdou de porta-pinceis' },
]

;(async () => {
  const svc = new FulfillmentFiscalService(null, new CompositionService())
  const r = await svc.produtosPendentesNcm(ORG, 120)
  const porSku = new Map(r.itens.map((i) => [i.sku, i]))
  let falhas = 0

  console.log('DEVE SUGERIR (e acertar o NCM):')
  for (const t of DEVE_SUGERIR) {
    const i = porSku.get(t.sku)
    const got = i?.sugestao?.ncm ?? null
    const ok = got === t.ncm
    if (!ok) falhas += 1
    console.log(`  ${ok ? 'OK  ' : 'FALHA'} ${t.sku.padEnd(20)} esperado ${t.ncm} · veio ${got ?? '(nenhuma)'}  — ${t.nota}`)
  }

  console.log('\nNAO PODE SUGERIR o valor errado:')
  for (const t of NAO_PODE_SUGERIR) {
    const i = porSku.get(t.sku)
    const got = i?.sugestao?.ncm ?? null
    const ok = got !== t.errado
    if (!ok) falhas += 1
    console.log(`  ${ok ? 'OK  ' : 'FALHA'} ${t.sku.padEnd(20)} nao pode vir ${t.errado} · veio ${got ?? '(nenhuma)'}  — ${t.nota}`)
  }

  const porNome = r.itens.filter((i) => i.sugestao?.base === 'nome')
  console.log(`\ncobertura: ${r.itens.filter((i) => i.sugestao).length}/${r.itens.length} (por nome: ${porNome.length})`)
  console.log(falhas === 0 ? '\n== QA PASSOU ==' : `\n== QA REPROVOU: ${falhas} falha(s) ==`)
  process.exit(falhas === 0 ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
