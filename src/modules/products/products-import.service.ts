import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import * as XLSX from 'xlsx'
import { supabaseAdmin } from '../../common/supabase'

/**
 * F1 — Importer de planilha de produtos (sessão 2026-05-14).
 *
 * Aceita .xlsx / .xls / .csv. Identifica colunas por aliases case-insensitive
 * normalizados (sem espaços, sem acentos). SKU é obrigatório. Para cada linha:
 *   - lookup por (org_id, sku); se existe → skip
 *   - se não existe → INSERT com tags=['cadastro_pendente'] + catalog_status='incomplete'
 *
 * Idempotência reforçada pelo UNIQUE INDEX parcial em (organization_id, sku)
 * onde sku IS NOT NULL — vide migration 20260566.
 */

export interface ImportRowError {
  row:      number
  sku?:     string
  message:  string
}

export interface ImportResult {
  batch_id:               string
  rows_total:             number
  rows_created:           number
  rows_skipped_existing:  number
  rows_errors:            number
  errors:                 ImportRowError[]
  column_mapping:         Record<string, string>
  preview_created:        Array<{ sku: string; name: string }>
}

/** Aliases para cada campo do produto. Match feito após normalize(). */
const COLUMN_ALIASES: Record<string, string[]> = {
  sku:              ['sku', 'codigo', 'cod', 'codigodoproduto', 'skupai', 'codpai', 'referencia', 'ref'],
  name:             ['nome', 'descricao', 'descricaoproduto', 'produto', 'titulo', 'nomeproduto'],
  brand:            ['marca', 'fabricante'],
  gtin:             ['gtin', 'ean', 'codigodebarras', 'eangtin', 'gtinean'],
  model:            ['modelo'],
  category:         ['categoria', 'departamento', 'grupodeprodutos'],
  cost_price:       ['custo', 'precocusto', 'precodecusto', 'custoreal', 'valordecusto', 'preçocusto', 'preçodecusto'],
  my_price:         ['preco', 'precovenda', 'valor', 'precovarejo', 'preçovenda'],
  weight_kg:        ['peso', 'pesokg', 'pesoreal', 'pesokilo', 'pesoliquido', 'pesoliquidokg', 'pesobruto', 'pesobrutokg'],
  width_cm:         ['largura', 'larguracm', 'larg', 'larguradoproduto'],
  length_cm:        ['comprimento', 'comprimentocm', 'compr', 'profundidade', 'profundidadedoproduto', 'profundidadecm'],
  height_cm:        ['altura', 'alturacm', 'alt', 'alturadoproduto'],
  ml_title:         ['titulomercadolivre', 'titulomelivre', 'tituloml'],
  description:      ['descricaolonga', 'observacoes', 'obs', 'detalhes', 'descricaocomplementar'],
  ncm:              ['ncm', 'codigoncm', 'codncm'],
  cest:             ['cest', 'codigocest'],
  origem:           ['origem', 'origemfiscal'],
  stock:            ['estoque', 'estoqueatual', 'qtd', 'quantidade'],
}

/** Normalize: lowercase + remove acentos + remove non-alphanum */
function normalize(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/** Mapeia headers da planilha → campos canônicos. Retorna { headerOriginal: campoCanonico } */
function buildColumnMapping(headers: string[]): { mapping: Record<string, string>; missing: string[] } {
  const mapping: Record<string, string> = {}
  const used = new Set<string>()
  for (const header of headers) {
    const norm = normalize(header)
    for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (used.has(canonical)) continue
      if (aliases.includes(norm) || normalize(canonical) === norm) {
        mapping[header] = canonical
        used.add(canonical)
        break
      }
    }
  }
  const missing: string[] = []
  if (!used.has('sku')) missing.push('SKU/Código')
  if (!used.has('name')) missing.push('Nome/Descrição')
  return { mapping, missing }
}

function parseNumeric(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    // BR: "1.234,56" → 1234.56  |  US: "1,234.56" ou "1234.56"
    let s = v.trim()
    if (s === '') return null
    // se tem "." E "," — assume BR (vírgula é decimal)
    if (s.includes('.') && s.includes(',')) {
      s = s.replace(/\./g, '').replace(',', '.')
    } else if (s.includes(',') && !s.includes('.')) {
      s = s.replace(',', '.')
    }
    s = s.replace(/[^0-9.\-]/g, '')
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function parseInt32(v: unknown): number | null {
  const n = parseNumeric(v)
  return n == null ? null : Math.trunc(n)
}

@Injectable()
export class ProductsImportService {
  private readonly log = new Logger(ProductsImportService.name)

  /**
   * Lê o buffer (arquivo subido), parseia primeira sheet e retorna { headers, rows }.
   * Use `dryRun: true` no controller pra dar preview antes do user confirmar.
   */
  parseBuffer(buf: Buffer, fileName: string): { headers: string[]; rows: Record<string, unknown>[] } {
    let wb: XLSX.WorkBook
    try {
      wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellNF: false, cellText: false })
    } catch (e) {
      throw new BadRequestException(`Não foi possível ler "${fileName}": ${(e as Error).message}`)
    }
    const sheetName = wb.SheetNames[0]
    if (!sheetName) throw new BadRequestException('Planilha vazia (sem abas).')
    const sheet = wb.Sheets[sheetName]
    // raw:true mantém números nativos (evita "7.89E+12" do Excel pra GTIN longos).
    // Strings ficam strings; números, números — parseNumeric/strOrNull lidam com ambos.
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: true,
      blankrows: false,
    })
    if (rows.length === 0) throw new BadRequestException('Planilha sem linhas de dados.')
    const headers = Object.keys(rows[0])
    return { headers, rows }
  }

  /**
   * Faz dry-run: parseia, mapeia colunas, conta quantos seriam criados vs skipped.
   * NÃO faz INSERT. Usado pra UI mostrar preview ao usuário antes de confirmar.
   */
  async dryRun(orgId: string, buf: Buffer, fileName: string): Promise<{
    headers:              string[]
    rows_count:           number
    column_mapping:       Record<string, string>
    missing_required:     string[]
    preview:              Array<{ row: number; sku: string; name: string; would_be: 'created' | 'skipped' | 'error'; reason?: string }>
    summary:              { would_create: number; would_skip: number; would_error: number }
  }> {
    const { headers, rows } = this.parseBuffer(buf, fileName)
    const { mapping, missing } = buildColumnMapping(headers)

    if (missing.length > 0) {
      return {
        headers,
        rows_count:       rows.length,
        column_mapping:   mapping,
        missing_required: missing,
        preview:          [],
        summary:          { would_create: 0, would_skip: 0, would_error: rows.length },
      }
    }

    // Quais SKUs já existem? — chunks de 200 (PostgREST tem limite de URL
    // ~16KB; planilhas com 2k+ linhas excediam num único .in() e retornavam 0).
    // Aceita numéricos (raw:true do XLSX traz SKUs puramente numéricos como number).
    const skus = rows
      .map(r => this.extractField(r, mapping, 'sku'))
      .filter(s => s != null && String(s).trim() !== '')
      .map(s => String(s).trim())
    const uniqueSkus = [...new Set(skus)]
    const existing = new Set<string>()
    if (uniqueSkus.length > 0) {
      for (let i = 0; i < uniqueSkus.length; i += 200) {
        const chunk = uniqueSkus.slice(i, i + 200)
        const { data, error } = await supabaseAdmin
          .from('products')
          .select('sku')
          .eq('organization_id', orgId)
          .in('sku', chunk)
        if (error) {
          this.log.warn(`[products-import] dryRun lookup chunk falhou: ${error.message}`)
          continue
        }
        for (const r of (data ?? []) as Array<{ sku: string | null }>) {
          if (r.sku) existing.add(r.sku)
        }
      }
    }

    const preview: Array<{ row: number; sku: string; name: string; would_be: 'created' | 'skipped' | 'error'; reason?: string }> = []
    let would_create = 0, would_skip = 0, would_error = 0
    rows.forEach((r, idx) => {
      const sku = this.extractField(r, mapping, 'sku')
      const name = this.extractField(r, mapping, 'name')
      const rowNum = idx + 2 // +1 header, +1 base-1
      if (!sku || String(sku).trim() === '') {
        preview.push({ row: rowNum, sku: '', name: String(name ?? ''), would_be: 'error', reason: 'SKU vazio' })
        would_error++
        return
      }
      if (!name || String(name).trim() === '') {
        preview.push({ row: rowNum, sku: String(sku), name: '', would_be: 'error', reason: 'Nome vazio' })
        would_error++
        return
      }
      const skuStr = String(sku).trim()
      if (existing.has(skuStr)) {
        preview.push({ row: rowNum, sku: skuStr, name: String(name), would_be: 'skipped', reason: 'SKU já cadastrado' })
        would_skip++
      } else {
        preview.push({ row: rowNum, sku: skuStr, name: String(name), would_be: 'created' })
        would_create++
      }
    })

    return {
      headers,
      rows_count:       rows.length,
      column_mapping:   mapping,
      missing_required: [],
      preview:          preview.slice(0, 50), // limita preview pra UI
      summary:          { would_create, would_skip, would_error },
    }
  }

  /**
   * Executa import real. Cria batch row + INSERT em massa pulando duplicados.
   * Marca produtos novos com tag 'cadastro_pendente' + catalog_status='incomplete'.
   */
  async commit(
    orgId: string,
    userId: string | null,
    buf: Buffer,
    fileName: string,
    fileSize: number,
    opts: { defaultTag?: string } = {},
  ): Promise<ImportResult> {
    const defaultTag = opts.defaultTag ?? 'cadastro_pendente'
    const { headers, rows } = this.parseBuffer(buf, fileName)
    const { mapping, missing } = buildColumnMapping(headers)

    // Cria batch row de auditoria
    const batchInsert = await supabaseAdmin
      .from('product_import_batches')
      .insert({
        organization_id:    orgId,
        created_by:         userId,
        file_name:          fileName,
        file_size_bytes:    fileSize,
        rows_total:         rows.length,
        column_mapping:     mapping,
        default_tag:        defaultTag,
        status:             'processing',
      })
      .select('id')
      .single()
    if (batchInsert.error || !batchInsert.data) {
      throw new BadRequestException(`Falha ao criar batch: ${batchInsert.error?.message ?? 'unknown'}`)
    }
    const batchId = batchInsert.data.id as string

    const errors: ImportRowError[] = []
    if (missing.length > 0) {
      errors.push({ row: 0, message: `Colunas obrigatórias ausentes: ${missing.join(', ')}` })
      await this.finalizeBatch(batchId, { rows_created: 0, rows_skipped_existing: 0, rows_errors: rows.length, errors, status: 'failed' })
      return {
        batch_id:               batchId,
        rows_total:             rows.length,
        rows_created:           0,
        rows_skipped_existing:  0,
        rows_errors:            rows.length,
        errors,
        column_mapping:         mapping,
        preview_created:        [],
      }
    }

    // Pré-fetch SKUs existentes (aceita numéricos vindos do XLSX raw:true)
    const skusInSheet = rows
      .map(r => this.extractField(r, mapping, 'sku'))
      .filter(s => s != null && String(s).trim() !== '')
      .map(s => String(s).trim())
    const uniqueSkus = [...new Set(skusInSheet)]
    const existingSet = new Set<string>()
    if (uniqueSkus.length > 0) {
      // chunks de 200 pra evitar URL grande no Supabase
      for (let i = 0; i < uniqueSkus.length; i += 200) {
        const chunk = uniqueSkus.slice(i, i + 200)
        const { data, error } = await supabaseAdmin
          .from('products')
          .select('sku')
          .eq('organization_id', orgId)
          .in('sku', chunk)
        if (error) {
          this.log.warn(`[products-import] lookup chunk falhou: ${error.message}`)
          continue
        }
        for (const r of (data ?? []) as Array<{ sku: string | null }>) {
          if (r.sku) existingSet.add(r.sku)
        }
      }
    }

    // Constrói INSERT batch — pula duplicados e linhas inválidas
    const inserts: Record<string, unknown>[] = []
    const previewCreated: Array<{ sku: string; name: string }> = []
    const seenInBatch = new Set<string>() // proteção contra SKU duplicado na própria planilha

    rows.forEach((r, idx) => {
      const rowNum = idx + 2
      const sku = this.extractField(r, mapping, 'sku')
      const name = this.extractField(r, mapping, 'name')
      if (!sku || String(sku).trim() === '') {
        errors.push({ row: rowNum, message: 'SKU vazio' })
        return
      }
      if (!name || String(name).trim() === '') {
        errors.push({ row: rowNum, sku: String(sku), message: 'Nome vazio' })
        return
      }
      const skuStr = String(sku).trim()
      if (existingSet.has(skuStr)) return // skip silencioso (será contado abaixo)
      if (seenInBatch.has(skuStr)) {
        errors.push({ row: rowNum, sku: skuStr, message: 'SKU duplicado dentro da própria planilha' })
        return
      }
      seenInBatch.add(skuStr)

      const product = this.buildProductPayload(orgId, r, mapping, defaultTag)
      inserts.push(product)
      previewCreated.push({ sku: skuStr, name: String(name).trim() })
    })

    const skipped = rows.length - inserts.length - errors.length

    let created = 0
    if (inserts.length > 0) {
      // INSERT em chunks de 100 pra evitar payload gigante
      for (let i = 0; i < inserts.length; i += 100) {
        const chunk = inserts.slice(i, i + 100)
        const { data, error } = await supabaseAdmin
          .from('products')
          .insert(chunk)
          .select('id')
        if (error) {
          // Pode acontecer race condition (sku já criado por outro request)
          // — registra como erro genérico do batch e continua
          this.log.warn(`[products-import] insert chunk falhou: ${error.message}`)
          errors.push({ row: 0, message: `Chunk insert falhou: ${error.message.slice(0, 200)}` })
          continue
        }
        created += (data ?? []).length
      }
    }

    const result: ImportResult = {
      batch_id:               batchId,
      rows_total:             rows.length,
      rows_created:           created,
      rows_skipped_existing:  skipped,
      rows_errors:            errors.length,
      errors:                 errors.slice(0, 100), // cap pra payload
      column_mapping:         mapping,
      preview_created:        previewCreated.slice(0, 50),
    }

    await this.finalizeBatch(batchId, {
      rows_created:           created,
      rows_skipped_existing:  skipped,
      rows_errors:            errors.length,
      errors:                 errors.slice(0, 200),
      status:                 'completed',
    })

    return result
  }

  private async finalizeBatch(batchId: string, patch: {
    rows_created:          number
    rows_skipped_existing: number
    rows_errors:           number
    errors?:               ImportRowError[]
    status:                'completed' | 'failed'
  }): Promise<void> {
    await supabaseAdmin
      .from('product_import_batches')
      .update({
        rows_created:           patch.rows_created,
        rows_skipped_existing:  patch.rows_skipped_existing,
        rows_errors:            patch.rows_errors,
        errors:                 patch.errors ?? [],
        status:                 patch.status,
        finished_at:            new Date().toISOString(),
      })
      .eq('id', batchId)
  }

  private extractField(row: Record<string, unknown>, mapping: Record<string, string>, canonical: string): unknown {
    for (const [header, mapped] of Object.entries(mapping)) {
      if (mapped === canonical) return row[header]
    }
    return undefined
  }

  private buildProductPayload(
    orgId: string,
    row: Record<string, unknown>,
    mapping: Record<string, string>,
    defaultTag: string,
  ): Record<string, unknown> {
    const get = (canon: string) => this.extractField(row, mapping, canon)
    const sku = String(get('sku')).trim()
    const name = String(get('name')).trim()

    const fiscal: Record<string, unknown> = {}
    const ncm = get('ncm')
    if (ncm != null && String(ncm).trim() !== '') fiscal.ncm = String(ncm).trim()
    const cest = get('cest')
    if (cest != null && String(cest).trim() !== '') fiscal.cest = String(cest).trim()
    const origem = get('origem')
    if (origem != null && String(origem).trim() !== '') fiscal.origem = String(origem).trim()

    return {
      organization_id:  orgId,
      sku,
      name,
      brand:            this.strOrNull(get('brand')),
      gtin:             this.strOrNull(get('gtin')),
      model:            this.strOrNull(get('model')),
      category:         this.strOrNull(get('category')),
      cost_price:       parseNumeric(get('cost_price')),
      my_price:         parseNumeric(get('my_price')),
      price:            parseNumeric(get('my_price')),
      weight_kg:        parseNumeric(get('weight_kg')),
      width_cm:         parseNumeric(get('width_cm')),
      length_cm:        parseNumeric(get('length_cm')),
      height_cm:        parseNumeric(get('height_cm')),
      ml_title:         this.strOrNull(get('ml_title')),
      description:      this.strOrNull(get('description')),
      stock:            parseInt32(get('stock')),
      fiscal:           Object.keys(fiscal).length > 0 ? fiscal : null,
      tags:             [defaultTag],
      catalog_status:   'incomplete',
      status:           'draft',     // pra não aparecer como ativo no /produtos
      condition:        'new',
      platforms:        [],
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }
  }

  private strOrNull(v: unknown): string | null {
    if (v == null) return null
    const s = String(v).trim()
    return s === '' ? null : s
  }

  /** GET /products/import-template — baixa .xlsx template com colunas sugeridas. */
  buildTemplate(): Buffer {
    const data = [
      {
        'SKU':           'EXEMPLO-001',
        'Nome':          'Produto de exemplo',
        'Marca':         'Acme',
        'GTIN':          '7891234567890',
        'Categoria':     'Categoria opcional',
        'Custo':         '10,50',
        'Preço':         '19,90',
        'Peso (kg)':     '0,500',
        'Largura (cm)':  '20',
        'Comprimento (cm)': '15',
        'Altura (cm)':   '5',
        'NCM':           '8504.40.90',
        'Estoque':       10,
        'Descrição':     'Descrição opcional do produto',
      },
    ]
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Produtos')
    return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer
  }

  /** GET /products/import-batches — histórico de uploads da org */
  async listBatches(orgId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await supabaseAdmin
      .from('product_import_batches')
      .select('id, file_name, rows_total, rows_created, rows_skipped_existing, rows_errors, status, created_at, finished_at, default_tag')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new BadRequestException(error.message)
    return data ?? []
  }
}
