import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common'
import { XMLParser } from 'fast-xml-parser'
import { supabaseAdmin } from '../../common/supabase'
import { ProductionInputService } from './production-input.service'

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
  unit: string; quantity: number; unit_cost: number; total: number
  kind: string; material: string | null
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

  constructor(private readonly inputs: ProductionInputService) {}

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
      tax_id: (emit.CNPJ ?? emit.CPF ?? null) || null,
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
      return {
        code: p.cProd != null ? String(p.cProd) : null,
        ean,
        description: desc,
        ncm: p.NCM ? String(p.NCM) : null,
        cfop: p.CFOP ? String(p.CFOP) : null,
        unit: String(p.uCom ?? 'UN').trim().toUpperCase(),
        quantity: Number(p.qCom ?? 0) || 0,
        unit_cost: Math.round((Number(p.vUnCom ?? 0) || 0) * 100) / 100,
        total: Math.round((Number(p.vProd ?? 0) || 0) * 100) / 100,
        kind: this.inferKind(desc),
        material: this.inferMaterial(desc),
      }
    }).filter(i => i.description)

    if (!items.length) throw new BadRequestException('Não encontrei itens na NF.')
    return { supplier, nf, items }
  }

  /** Preview: parseia, casa o fornecedor (por CNPJ) e cada item (por sku/nome). */
  async importPreview(orgId: string, xml: string): Promise<NfeParsed & {
    supplier_existing_id: string | null
    already_imported: boolean
    items_matched: Array<{ index: number; input_id: string | null; input_name: string | null }>
  }> {
    const parsed = this.parse(xml)

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
    items: Array<{ include?: boolean; link_input_id?: string | null; name: string; sku?: string | null; unit?: string; quantity: number; unit_cost: number; kind?: string; material?: string | null; description?: string | null }>
  }): Promise<{ supplier_id: string; created: number; restocked: number }> {
    // trava anti-duplicação
    if (body.nf.access_key) {
      const { data } = await supabaseAdmin.from('nfe_import_log').select('id')
        .eq('organization_id', orgId).eq('access_key', body.nf.access_key).limit(1).maybeSingle()
      if (data) throw new ConflictException('Esta NF já foi importada antes.')
    }

    // 1. fornecedor
    let supplierId = body.supplier.use_existing_id ?? null
    if (!supplierId && body.supplier.tax_id) {
      const { data } = await supabaseAdmin.from('suppliers').select('id')
        .eq('organization_id', orgId).eq('tax_id', body.supplier.tax_id).limit(1).maybeSingle()
      supplierId = (data as { id: string } | null)?.id ?? null
    }
    if (!supplierId) {
      const { data, error } = await supabaseAdmin.from('suppliers').insert({
        organization_id: orgId, name: body.supplier.name, legal_name: body.supplier.legal_name || null,
        tax_id: body.supplier.tax_id, country: 'BR', supplier_type: 'nacional',
        contact_phone: body.supplier.phone, address: body.supplier.address ?? {}, is_active: true, created_by: userId,
        notes: body.supplier.ie ? `IE: ${body.supplier.ie}` : null,
      }).select('id').maybeSingle()
      if (error || !data) throw new BadRequestException(`Erro ao criar fornecedor: ${error?.message ?? 'sem dados'}`)
      supplierId = (data as { id: string }).id
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
          name: it.name, sku: it.sku ?? null, kind: this.normKind(it.kind), material: it.material ?? null,
          unit: this.normUnit(it.unit), supplier: supplierName, description: it.description ?? null,
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
