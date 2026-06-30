import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common'
import { XMLParser } from 'fast-xml-parser'
import { supabaseAdmin } from '../../common/supabase'
import { ProductionInputService } from './production-input.service'
import { LlmService } from '../ai/llm.service'

/**
 * Importação de NF-e de insumo (XML).
 *
 * Sobe o XML da nota de COMPRA → o emitente vira o FORNECEDOR (suppliers) e
 * cada item vira/abastece um INSUMO (production_input) com uma entrada de
 * estoque ao custo da nota — que recalcula o CUSTO MÉDIO PONDERADO (WAC).
 * Determinístico (fast-xml-parser); a mesma chave de NF não entra estoque 2×.
 */

interface NfeSupplier {
  tax_id: string | null; name: string; legal_name: string; ie: string | null
  phone: string | null; address: Record<string, string | null>
}
interface NfeItem {
  code: string | null; ean: string | null; description: string; ncm: string | null; cfop: string | null
  // valores RESOLVIDOS p/ o insumo (filamento já convertido p/ gramas)
  unit: string; quantity: number; unit_cost: number; total: number
  kind: string; material: string | null; color: string | null; color_hex: string | null; diameter_mm: number | null; spool_weight_g: number | null
  // valores ORIGINAIS da NF (p/ transparência na revisão)
  raw_unit: string; raw_quantity: number; raw_unit_cost: number; conversion: string | null
}
export interface NfeParsed {
  supplier: NfeSupplier
  nf: { number: string | null; serie: string | null; date: string | null; access_key: string | null; total: number }
  items: NfeItem[]
}

@Injectable()
export class NfeImportService {
  private readonly logger = new Logger(NfeImportService.name)
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true })

  constructor(
    private readonly inputs: ProductionInputService,
    private readonly llm: LlmService,
  ) {}

  /** Lê o DANFE (PDF) via IA (documento nativo) e normaliza no mesmo shape. */
  async parsePdf(orgId: string, pdfBase64: string): Promise<NfeParsed> {
    if (!pdfBase64?.trim()) throw new BadRequestException('PDF ausente.')
    const out = await this.llm.analyzeDocument({
      orgId, feature: 'nfe_pdf_extract', pdfBase64, jsonMode: true, maxTokens: 3000,
      systemPrompt: 'Você extrai dados de uma NF-e brasileira (DANFE em PDF). Leia a tabela de produtos com cuidado. Devolva SOMENTE JSON.',
      userPrompt: NFE_PDF_PROMPT,
    })
    const parsed = parseJsonLoose(out.text) as any
    if (!parsed || typeof parsed !== 'object') throw new BadRequestException('Não consegui ler a NF do PDF. Tente o XML (mais confiável).')

    const e = parsed.supplier ?? {}
    const supplier: NfeSupplier = {
      tax_id: String(e.tax_id ?? e.cnpj ?? '').replace(/\D/g, '') || null,
      name: String(e.name ?? 'Fornecedor').trim(),
      legal_name: String(e.legal_name ?? e.name ?? '').trim(),
      ie: e.ie ? String(e.ie) : null,
      phone: e.phone ? String(e.phone) : null,
      address: (e.address && typeof e.address === 'object') ? e.address : {},
    }
    const n = parsed.nf ?? {}
    const nf = {
      number: n.number != null ? String(n.number) : null, serie: n.serie != null ? String(n.serie) : null,
      date: (n.date ?? null) as string | null, access_key: String(n.access_key ?? '').replace(/\D/g, '') || null,
      total: Number(n.total ?? 0) || 0,
    }
    const items: NfeItem[] = (Array.isArray(parsed.items) ? parsed.items : []).map((p: any) => {
      const desc = String(p.description ?? '').trim()
      const rawUnit = String(p.unit ?? 'UN').trim().toUpperCase()
      const rawQty = Number(p.quantity ?? 0) || 0
      const rawCost = Math.round((Number(p.unit_cost ?? 0) || 0) * 100) / 100
      const kind = this.inferKind(desc)
      const r = this.resolveItem(desc, kind, rawUnit, rawQty, rawCost)
      return {
        code: p.code != null ? String(p.code) : null, ean: null, description: desc,
        ncm: p.ncm != null ? String(p.ncm) : null, cfop: p.cfop != null ? String(p.cfop) : null,
        total: Math.round((Number(p.total ?? 0) || 0) * 100) / 100, kind,
        unit: r.unit, quantity: r.quantity, unit_cost: r.unit_cost,
        material: r.material, color: r.color, color_hex: r.color_hex, diameter_mm: r.diameter_mm, spool_weight_g: r.spool_weight_g,
        raw_unit: rawUnit, raw_quantity: rawQty, raw_unit_cost: rawCost, conversion: r.conversion,
      }
    }).filter((i: NfeItem) => i.description)
    if (!items.length) throw new BadRequestException('Não encontrei itens na NF do PDF.')
    return { supplier, nf, items }
  }

  private inferKind(desc: string): 'filamento' | 'embalagem' | 'etiqueta' | 'outro' {
    const d = (desc || '').toLowerCase()
    if (/\b(pla|petg|abs|tpu|asa|nylon|\bpa\b|\bpc\b|filament|filamento|resina|resin)\b/.test(d)) return 'filamento'
    if (/etiqueta|r[oó]tulo/.test(d)) return 'etiqueta'
    if (/caixa|embalagem|sacol|saco|bolha|fita|lacre|plast/.test(d)) return 'embalagem'
    return 'outro'
  }
  private normKind(k?: string): 'filamento' | 'embalagem' | 'etiqueta' | 'outro' {
    return k === 'filamento' || k === 'embalagem' || k === 'etiqueta' ? k : 'outro'
  }
  /** Mapeia a unidade da NF (KG/MT/UN/PC/ROLO…) p/ a do insumo. */
  private normUnit(u?: string): 'g' | 'kg' | 'un' | 'm' {
    const x = (u || '').toLowerCase()
    if (/^kg|quilo/.test(x)) return 'kg'
    if (/^g\b|grama/.test(x)) return 'g'
    if (/^m\b|^mt|metro/.test(x)) return 'm'
    return 'un'
  }
  private inferMaterial(desc: string): string | null {
    const m = (desc || '').match(/\b(PLA|PETG|ABS|TPU|ASA|PC|Nylon|PA)\b/i)
    return m ? m[1].toUpperCase() : null
  }
  private inferColor(desc: string): string | null {
    const d = (desc || '')
    // cores compostas primeiro (verde oliva, azul petróleo, cinza chumbo…)
    const comp = d.match(/\b(verde\s+(?:oliva|militar|menta|lim[ãa]o|gua|água)|azul\s+(?:petr[óo]leo|beb[êe]|marinho|royal|turquesa)|cinza\s+(?:chumbo|espacial|grafite)|rosa\s+(?:beb[êe]|choque))\b/i)
    if (comp) return this.titleCase(comp[1])
    const m = d.match(/\b(branco|preto|cinza|prata|dourado|vermelho|laranja|amarelo|verde|azul|roxo|violeta|lil[áa]s|rosa|marrom|bege|oliva|petr[óo]leo|turquesa|ciano|magenta|vinho|grafite|chumbo|natural|transl[uú]cido|transparente|fluor|neon|ouro)\w*/i)
    return m ? this.titleCase(m[0]) : null
  }
  private titleCase(s: string): string { return s.split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' ') }
  /** Hex aproximado da cor (p/ swatch + auto-match por cor no multicor). Best-effort. */
  private colorHex(color: string | null): string | null {
    if (!color) return null
    const c = color.toLowerCase()
    const map: Array<[RegExp, string]> = [
      [/oliva|militar/, '#68724D'], [/petr[óo]leo/, '#1B4D5C'], [/turquesa/, '#30D5C8'], [/menta/, '#9FE2BF'],
      [/marinho/, '#1F2A44'], [/royal/, '#2547C0'], [/beb[êe]/, '#A7C7E7'],
      [/chumbo|grafite/, '#3A3A3A'], [/osso/, '#E3DAC9'], [/bege|natural/, '#E8DBB7'],
      [/vinho/, '#722F37'], [/laranja/, '#F97316'], [/amarelo|ouro|dourado/, '#EAB308'],
      [/lil[áa]s|violeta|roxo/, '#7C3AED'], [/magenta/, '#D6336C'], [/rosa/, '#EC4899'], [/marrom/, '#7C4A2D'],
      [/ciano/, '#22D3EE'], [/prata/, '#C0C0C0'],
      [/\bazul\b|^azul/, '#2563EB'], [/\bcinza\b|^cinza/, '#9AA0A6'], [/\bpreto\b|^preto/, '#111111'],
      [/\bbranco\b|^branco/, '#F5F5F5'], [/\bvermelho\b|^vermelho/, '#DC2626'], [/\bverde\b|^verde/, '#16A34A'],
    ]
    for (const [re, hex] of map) if (re.test(c)) return hex
    return null
  }
  private inferDiameter(desc: string): number | null {
    const m = (desc || '').match(/\b(1[.,]75|2[.,]85|3[.,]0{1,2}|3)\s*mm/i)
    if (m) return Number(m[1].replace(',', '.'))
    return null
  }
  /** Peso em GRAMAS da descrição (1kg→1000, 750g→750). Ignora diâmetro (mm). */
  private inferWeightGrams(desc: string): number | null {
    const kg = (desc || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|kilo|quilo)/i)
    if (kg) return Math.round(Number(kg[1].replace(',', '.')) * 1000)
    const g = (desc || '').match(/(\d{2,5})\s*g(?:ramas?)?\b/i)
    if (g) return Number(g[1])
    return null
  }

  /** Resolve os campos do insumo. FILAMENTO converte p/ GRAMAS (unidade default
   *  do sistema): qtd em g, custo por g, peso do rolo. Ex: 1 UN "PLA 1kg" R$110
   *  → 1000 g @ R$0,11/g. Outros tipos mantêm a unidade da NF. */
  private resolveItem(desc: string, kind: string, rawUnit: string, rawQty: number, rawCost: number): {
    unit: string; quantity: number; unit_cost: number; material: string | null; color: string | null; color_hex: string | null
    diameter_mm: number | null; spool_weight_g: number | null; conversion: string | null
  } {
    const material = this.inferMaterial(desc)
    const color = this.inferColor(desc)
    const color_hex = this.colorHex(color)
    const diameter_mm = this.inferDiameter(desc)
    const weight = this.inferWeightGrams(desc)
    const u = (rawUnit || '').toLowerCase()

    if (kind === 'filamento') {
      let totalG: number | null = null, perG: number | null = null, spool: number | null = weight
      let assumed = false
      if (/^kg|quilo/.test(u))      { totalG = rawQty * 1000; perG = rawCost / 1000 }
      else if (/^g\b|grama/.test(u)) { totalG = rawQty; perG = rawCost }
      else if (weight)               { totalG = rawQty * weight; perG = rawCost / weight; spool = weight } // UN/PC/ROLO + peso na descrição
      else if (!/^m\b|^mt|metro/.test(u)) {                                                                // UN/PC/ROLO sem peso → assume rolo de 1kg (revisável)
        spool = 1000; totalG = rawQty * 1000; perG = rawCost / 1000; assumed = true
      }
      if (totalG != null && perG != null && totalG > 0) {
        const quantity = Math.round(totalG)
        const unit_cost = Math.round(perG * 1e6) / 1e6
        const detail = weight ? ` de ${weight}g` : (assumed ? ' (rolo 1kg assumido)' : '')
        const conversion = `${rawQty} ${rawUnit}${detail} → ${quantity} g @ R$ ${unit_cost.toFixed(5)}/g${assumed ? ' — confira o peso do rolo' : ''}`
        return { unit: 'g', quantity, unit_cost, material, color, color_hex, diameter_mm, spool_weight_g: spool, conversion }
      }
    }
    // não-filamento (ou filamento sem peso detectável): mantém a unidade da NF
    return { unit: this.normUnit(rawUnit), quantity: rawQty, unit_cost: rawCost, material, color, color_hex, diameter_mm, spool_weight_g: weight, conversion: null }
  }

  /** Parseia o XML da NF-e e normaliza fornecedor + itens. */
  parse(xml: string): NfeParsed {
    if (!xml?.trim() || !/<\s*(nfeProc|NFe)\b/.test(xml)) throw new BadRequestException('Arquivo não parece um XML de NF-e.')
    let j: any
    try { j = this.parser.parse(xml) } catch { throw new BadRequestException('Não consegui ler o XML (arquivo corrompido?).') }
    const inf = j?.nfeProc?.NFe?.infNFe ?? j?.NFe?.infNFe
    if (!inf) throw new BadRequestException('XML não é uma NF-e válida (não achei infNFe).')

    const emit = inf.emit ?? {}
    const ender = emit.enderEmit ?? {}
    const supplier: NfeSupplier = {
      tax_id: String(emit.CNPJ ?? emit.CPF ?? '').replace(/\D/g, '') || null, // só dígitos p/ dedupe robusto
      name: String(emit.xFant || emit.xNome || 'Fornecedor').trim(),
      legal_name: String(emit.xNome || emit.xFant || '').trim(),
      ie: emit.IE ? String(emit.IE) : null,
      phone: ender.fone ? String(ender.fone) : null,
      address: {
        street: ender.xLgr ?? null, number: ender.nro ?? null, complement: ender.xCpl ?? null,
        district: ender.xBairro ?? null, city: ender.xMun ?? null, uf: ender.UF ?? null, zip: ender.CEP ?? null,
      },
    }

    const ide = inf.ide ?? {}
    const accessKey = String(inf['@_Id'] ?? '').replace(/^NFe/i, '') || null
    const nf = {
      number: ide.nNF ? String(ide.nNF) : null,
      serie: ide.serie ? String(ide.serie) : null,
      date: (ide.dhEmi || ide.dEmi || null) as string | null,
      access_key: accessKey,
      total: Number(inf.total?.ICMSTot?.vNF ?? 0) || 0,
    }

    const detRaw = inf.det
    const det: any[] = Array.isArray(detRaw) ? detRaw : (detRaw ? [detRaw] : [])
    const items: NfeItem[] = det.map(d => {
      const p = d.prod ?? {}
      const desc = String(p.xProd ?? '').trim()
      const ean = p.cEAN && !/SEM GTIN/i.test(String(p.cEAN)) ? String(p.cEAN) : null
      const rawUnit = String(p.uCom ?? 'UN').trim().toUpperCase()
      const rawQty = Number(p.qCom ?? 0) || 0
      const rawCost = Math.round((Number(p.vUnCom ?? 0) || 0) * 100) / 100
      const kind = this.inferKind(desc)
      const r = this.resolveItem(desc, kind, rawUnit, rawQty, rawCost)
      return {
        code: p.cProd != null ? String(p.cProd) : null, ean, description: desc,
        ncm: p.NCM ? String(p.NCM) : null, cfop: p.CFOP ? String(p.CFOP) : null,
        total: Math.round((Number(p.vProd ?? 0) || 0) * 100) / 100, kind,
        unit: r.unit, quantity: r.quantity, unit_cost: r.unit_cost,
        material: r.material, color: r.color, color_hex: r.color_hex, diameter_mm: r.diameter_mm, spool_weight_g: r.spool_weight_g,
        raw_unit: rawUnit, raw_quantity: rawQty, raw_unit_cost: rawCost, conversion: r.conversion,
      }
    }).filter(i => i.description)

    if (!items.length) throw new BadRequestException('Não encontrei itens na NF.')
    return { supplier, nf, items }
  }

  /** Preview a partir do XML. */
  async importPreview(orgId: string, xml: string) {
    return this.buildPreview(orgId, this.parse(xml))
  }

  /** Preview a partir do PDF (DANFE) — IA lê o documento. */
  async importPreviewFromPdf(orgId: string, pdfBase64: string) {
    return this.buildPreview(orgId, await this.parsePdf(orgId, pdfBase64))
  }

  /** Casa o fornecedor (por CNPJ) e cada item (por sku/nome) + avisa NF duplicada. */
  private async buildPreview(orgId: string, parsed: NfeParsed): Promise<NfeParsed & {
    supplier_existing_id: string | null
    already_imported: boolean
    items_matched: Array<{ index: number; input_id: string | null; input_name: string | null }>
  }> {
    // fornecedor já cadastrado? (por CNPJ)
    let supplierExistingId: string | null = null
    if (parsed.supplier.tax_id) {
      const { data } = await supabaseAdmin.from('suppliers').select('id')
        .eq('organization_id', orgId).eq('tax_id', parsed.supplier.tax_id).eq('is_active', true).limit(1).maybeSingle()
      supplierExistingId = (data as { id: string } | null)?.id ?? null
    }

    // NF já importada?
    let already = false
    if (parsed.nf.access_key) {
      const { data } = await supabaseAdmin.from('nfe_import_log').select('id')
        .eq('organization_id', orgId).eq('access_key', parsed.nf.access_key).limit(1).maybeSingle()
      already = !!data
    }

    // casa cada item a um insumo existente (sku exato, senão nome)
    const items_matched: Array<{ index: number; input_id: string | null; input_name: string | null }> = []
    for (let i = 0; i < parsed.items.length; i++) {
      const it = parsed.items[i]
      let match: { id: string; name: string } | null = null
      if (it.code) {
        const { data } = await supabaseAdmin.from('production_input').select('id, name')
          .eq('organization_id', orgId).eq('is_active', true).eq('sku', it.code).limit(1).maybeSingle()
        match = (data as { id: string; name: string } | null) ?? null
      }
      if (!match) {
        const { data } = await supabaseAdmin.from('production_input').select('id, name')
          .eq('organization_id', orgId).eq('is_active', true).ilike('name', it.description).limit(1).maybeSingle()
        match = (data as { id: string; name: string } | null) ?? null
      }
      items_matched.push({ index: i, input_id: match?.id ?? null, input_name: match?.name ?? null })
    }

    return { ...parsed, supplier_existing_id: supplierExistingId, already_imported: already, items_matched }
  }

  /** Commit: cria/usa fornecedor + cria/abastece insumos (entrada WAC). */
  async importCommit(orgId: string, userId: string | null, body: {
    supplier: NfeSupplier & { use_existing_id?: string | null }
    nf: { access_key: string | null; number: string | null; total?: number }
    items: Array<{ include?: boolean; link_input_id?: string | null; name: string; sku?: string | null; barcode?: string | null; unit?: string; quantity: number; unit_cost: number; kind?: string; material?: string | null; description?: string | null; color?: string | null; color_hex?: string | null; diameter_mm?: number | null; spool_weight_g?: number | null }>
    force?: boolean // reimportar uma NF já carimbada (ex.: insumos foram excluídos e o user quer recriar)
  }): Promise<{ supplier_id: string; created: number; restocked: number }> {
    // trava anti-duplicação — só barra quando NÃO é reimportação explícita
    if (body.nf.access_key && !body.force) {
      const { data } = await supabaseAdmin.from('nfe_import_log').select('id')
        .eq('organization_id', orgId).eq('access_key', body.nf.access_key).limit(1).maybeSingle()
      if (data) throw new ConflictException('Esta NF já foi importada antes.')
    }
    // reimportação: remove o carimbo antigo p/ o índice único não barrar o novo log
    if (body.nf.access_key && body.force) {
      await supabaseAdmin.from('nfe_import_log')
        .delete().eq('organization_id', orgId).eq('access_key', body.nf.access_key)
    }

    // 1. fornecedor — NUNCA duplica: usa o existente (por id ou CNPJ); só cria se não houver
    const taxId = String(body.supplier.tax_id ?? '').replace(/\D/g, '') || null
    const findByTaxId = async (): Promise<string | null> => {
      if (!taxId) return null
      const { data } = await supabaseAdmin.from('suppliers').select('id')
        .eq('organization_id', orgId).eq('tax_id', taxId).limit(1).maybeSingle()
      return (data as { id: string } | null)?.id ?? null
    }
    let supplierId = body.supplier.use_existing_id ?? (await findByTaxId())
    if (!supplierId) {
      const { data, error } = await supabaseAdmin.from('suppliers').insert({
        organization_id: orgId, name: body.supplier.name, legal_name: body.supplier.legal_name || null,
        tax_id: taxId, country: 'BR', supplier_type: 'nacional',
        contact_phone: body.supplier.phone, address: body.supplier.address ?? {}, is_active: true, created_by: userId,
        notes: body.supplier.ie ? `IE: ${body.supplier.ie}` : null,
      }).select('id').maybeSingle()
      if (data) supplierId = (data as { id: string }).id
      else {
        // corrida/duplicata barrada pelo índice único → reusa o que já existe
        supplierId = await findByTaxId()
        if (!supplierId) throw new BadRequestException(`Erro ao criar fornecedor: ${error?.message ?? 'sem dados'}`)
      }
    }
    const supplierName = body.supplier.name

    // 2. itens → cria ou abastece + entrada WAC
    let created = 0, restocked = 0
    const nfRef = body.nf.number ? `NF ${body.nf.number}` : 'NF'
    for (const it of body.items) {
      if (it.include === false) continue
      const qty = Math.max(0, Number(it.quantity) || 0)
      const cost = Math.max(0, Number(it.unit_cost) || 0)
      if (qty <= 0) continue
      let inputId = it.link_input_id ?? null
      if (!inputId) {
        const novo = await this.inputs.create(orgId, {
          name: it.name, sku: it.sku ?? null, barcode: it.barcode ?? null, kind: this.normKind(it.kind), material: it.material ?? null,
          unit: this.normUnit(it.unit), supplier: supplierName, description: it.description ?? null,
          color: it.color ?? null, color_hex: it.color_hex ?? null, diameter_mm: it.diameter_mm ?? null, spool_weight_g: it.spool_weight_g ?? null,
          quantity: 0, cost_per_unit: 0,
        })
        inputId = novo.id
        created++
      } else { restocked++ }
      await this.inputs.movement(orgId, inputId, { type: 'in', quantity: qty, unit_cost: cost, notes: nfRef }, userId)
    }

    // 3. log anti-duplicação
    if (body.nf.access_key) {
      await supabaseAdmin.from('nfe_import_log').insert({
        organization_id: orgId, access_key: body.nf.access_key, nf_number: body.nf.number,
        supplier_id: supplierId, supplier_tax_id: body.supplier.tax_id, items_count: created + restocked,
        total_value: body.nf.total ?? null, created_by: userId,
      }).then(() => {}, () => {})
    }

    return { supplier_id: supplierId, created, restocked }
  }
}

const NFE_PDF_PROMPT = `Extraia os dados desta NF-e (DANFE) e responda em JSON com EXATAMENTE este formato:
{
  "supplier": { "tax_id": "CNPJ do EMITENTE só dígitos", "name": "nome fantasia ou razão social", "legal_name": "razão social", "ie": "inscrição estadual ou null", "phone": "telefone ou null", "address": { "city": "município", "uf": "UF" } },
  "nf": { "number": "número da nota", "serie": "série", "access_key": "chave de acesso de 44 dígitos só números", "total": valor_total_da_nota },
  "items": [ { "code": "código do produto do fornecedor", "description": "descrição do produto", "ncm": "NCM", "unit": "unidade (UN, KG, PC, MT...)", "quantity": quantidade_numérica, "unit_cost": valor_unitário_numérico, "total": valor_total_do_item } ]
}
Regras: o EMITENTE é o fornecedor (quem vendeu), NÃO o destinatário. Números com ponto decimal. Liste TODOS os itens da tabela de produtos. Se um campo não existir, use null.`

function parseJsonLoose(text: string): unknown {
  const t = (text ?? '').trim()
  try { return JSON.parse(t) } catch { /* continua */ }
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (m) { try { return JSON.parse(m[1]) } catch { /* continua */ } }
  const o = t.indexOf('{'), c = t.lastIndexOf('}')
  if (o >= 0 && c > o) { try { return JSON.parse(t.slice(o, c + 1)) } catch { /* continua */ } }
  return null
}
