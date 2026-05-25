/**
 * Smoke do GEO Score (AI Visibility — Sprint 2 Parte 1).
 *
 * Instancia os services NA MÃO (sem Nest DI — tsx/esbuild não emite o
 * metadata de decorator que o container precisa; mesmo padrão dos outros
 * smokes do projeto). Roda: scrape(url) → calculate().
 *
 * Uso: npx tsx scripts/test-geo-score.ts [url]
 *
 * ⚠️ As 7 dimensões via LLM precisam da ENCRYPTION_KEY (chaves do api_credentials
 * são AES — só no Railway). Local, sem a key, elas caem no caminho de erro
 * (score 0); o scraper (dados ML reais) + crawler_access (robots.txt real)
 * validam mesmo assim. Pra rodar completo local:
 *   ENCRYPTION_KEY=<32chars> npx tsx scripts/test-geo-score.ts
 */
import 'dotenv/config' // PRIMEIRA linha: carrega .env antes dos imports que tocam supabase.ts

import { ListingScraperService } from '../src/modules/ai-visibility/geo-score/services/listing-scraper.service'
import { GeoScoreCalculatorService } from '../src/modules/ai-visibility/geo-score/services/geo-score-calculator.service'
import { LlmService } from '../src/modules/ai/llm.service'
import { CredentialsService } from '../src/modules/credentials/credentials.service'
import type { MercadolivreService } from '../src/modules/mercadolivre/mercadolivre.service'

const ORG = '4ef1aabd-c209-40b0-b034-ef69dcb66833'
const URL = process.argv[2]
  || 'https://produto.mercadolivre.com.br/MLB-6724010452-luminaria-pendente-antirruido-moderno-45cm-e27-bivolt-vazzo-127220v-preto-_JM'

/** Lê um token ML válido da org direto do banco (sem refresh) pra alimentar o stub. */
async function getMlToken(): Promise<{ token: string; sellerId: number }> {
  const SUPA = process.env.SUPABASE_URL
  const KEY  = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  const res = await fetch(`${SUPA}/rest/v1/rpc/_admin_query_sql`, {
    method: 'POST',
    headers: { apikey: KEY!, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sql: `SELECT access_token, seller_id FROM ml_connections WHERE organization_id='${ORG}' AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`,
    }),
  })
  const rows = await res.json() as Array<{ access_token: string; seller_id: number }>
  if (!rows?.[0]?.access_token) throw new Error('nenhum token ML válido pra org no banco')
  return { token: rows[0].access_token, sellerId: rows[0].seller_id }
}

async function main() {
  const t0 = Date.now()

  const { token, sellerId } = await getMlToken()
  // Stub do MercadolivreService — só precisamos do getTokenForOrg pro scraper ML.
  const mlStub = { getTokenForOrg: async () => ({ token, sellerId }) } as unknown as MercadolivreService

  const scraper = new ListingScraperService(mlStub)
  const calc    = new GeoScoreCalculatorService(new LlmService(new CredentialsService()))

  console.log('=== SCRAPE ===')
  console.log('URL:', URL)
  const scraped = await scraper.scrape(URL, ORG)
  console.log(JSON.stringify({
    ...scraped,
    description: scraped.description ? `${scraped.description.slice(0, 200)}… (${scraped.description.length} chars)` : null,
    rawHtmlSnippet: scraped.rawHtmlSnippet ? '[omitido]' : null,
  }, null, 2))

  console.log('\n=== GEO SCORE ===')
  const result = await calc.calculate(ORG, scraped)
  console.log(JSON.stringify(result, null, 2))
  console.log(`\nRESUMO: geoScore=${result.geoScore}/100 | dimensões=${result.dimensions.length} | custo=$${result.costUsd.toFixed(4)} | tempo=${((Date.now() - t0) / 1000).toFixed(1)}s`)

  process.exit(0)
}

main().catch((e) => {
  console.error('SMOKE ERRO:', e?.message || e)
  process.exit(1)
})
