#!/usr/bin/env node
/**
 * Backfill: produto de COR ÚNICA marcado como variável.
 *
 * O publish do Product OS marcava `has_variations=true` sempre que existia ≥1
 * `product_dev_sku_variant` — e a aba SKU EXIGE uma cor pra fechar o código, de
 * modo que TODO produto nascia "variável", mesmo tendo uma cor só. Efeitos:
 *   - o EAN da cor ficava preso em `variations[0].ean` e `products.ean/gtin`
 *     nulos;
 *   - o publish no ML montava um anúncio variável de 1 variação, que o ML
 *     rejeita (cause 374 `variations` + `family_name`, cause 369
 *     `[available_quantity]`).
 * A regra virou "variável só com ≥2 variantes" em product-os.service.ts; este
 * script conserta as linhas que já nasceram erradas.
 *
 * O que faz em cada produto com has_variations=true e EXATAMENTE 1 variação:
 *   has_variations → false · variations → [] · ean/gtin ← ean da variação
 *     (só quando o produto está sem código).
 * NÃO mexe em preço, estoque nem SKU — divergências são só REPORTADAS.
 *
 * Uso:
 *   node scripts/fix-falsas-variacoes.mjs            # dry-run (padrão)
 *   node scripts/fix-falsas-variacoes.mjs --apply    # grava
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, '..', '.env') })

const SUPA_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL || !KEY) {
  console.error('[fix-falsas-variacoes] FATAL: SUPABASE_URL / SUPABASE_SECRET_KEY não setados em .env')
  process.exit(1)
}

const APPLY = process.argv.includes('--apply')
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const rest = async (p, init) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/${p}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } })
  const t = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${p}: ${t.slice(0, 400)}`)
  return t ? JSON.parse(t) : null
}

const rows = await rest('products?has_variations=eq.true&select=id,organization_id,name,sku,ean,gtin,price,stock,variations')
const alvos = rows.filter(p => Array.isArray(p.variations) && p.variations.length === 1)

console.log(`\n${APPLY ? '=== APLICANDO ===' : '=== DRY-RUN (use --apply pra gravar) ==='}`)
console.log(`${rows.length} produtos com has_variations=true · ${alvos.length} com UMA variação (alvos)\n`)

const avisos = []
let gravados = 0

for (const p of alvos) {
  const v = p.variations[0] ?? {}
  const eanAtual = (p.gtin ?? p.ean ?? '').trim()
  const eanVar = typeof v.ean === 'string' ? v.ean.trim() : ''
  const patch = { has_variations: false, variations: [], updated_at: new Date().toISOString() }
  if (!eanAtual && eanVar) { patch.ean = eanVar; patch.gtin = eanVar }

  console.log(`• ${p.sku ?? '(sem sku)'} — ${p.name}`)
  console.log(`    variação: ${JSON.stringify(v.attributes ?? v.value ?? {})} · sku ${v.sku ?? '—'} · ean ${eanVar || '—'}`)
  console.log(`    ean/gtin do produto: ${eanAtual || 'null'}${patch.ean ? ` → ${patch.ean}` : ' (mantém)'}`)

  const precoVar = v.price != null ? Number(v.price) : null
  if (precoVar != null && Number(p.price) !== precoVar) {
    avisos.push(`${p.sku}: preço do produto R$${p.price} ≠ preço da variação R$${precoVar} — decidir qual vale (script NÃO altera)`)
  }
  const estoqueVar = v.stock != null ? Number(v.stock) : null
  if (estoqueVar != null && Number(p.stock ?? 0) < estoqueVar) {
    avisos.push(`${p.sku}: products.stock=${p.stock} < estoque da variação=${estoqueVar} — conferir o ledger ANTES de limpar variations`)
  }
  if (!eanAtual && !eanVar) {
    avisos.push(`${p.sku}: sem EAN em lugar nenhum — gere o EAN no Product OS antes de publicar no ML`)
  }

  if (APPLY) {
    await rest(`products?id=eq.${p.id}&organization_id=eq.${p.organization_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    })
    gravados++
    console.log('    ✓ gravado')
  }
}

if (avisos.length) {
  console.log(`\n=== AVISOS (${avisos.length}) — nada foi alterado nestes campos ===`)
  for (const a of avisos) console.log(`  ! ${a}`)
}
console.log(`\n${APPLY ? `✓ ${gravados} produtos corrigidos` : 'dry-run — nada foi gravado'}\n`)
