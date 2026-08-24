import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import * as forge from 'node-forge'
import { supabaseAdmin } from '../../common/supabase'
import { CredentialsService } from '../credentials/credentials.service'

export type FiscalProvider = 'nfeio' | 'focusnfe' | 'plugnotas' | 'erp_externo'
export type FiscalEnvironment = 'homologacao' | 'producao'
export type RegimeTributario = 'simples' | 'presumido' | 'real' | 'mei'

export interface CompanyFiscalConfig {
  id: string
  company_id: string
  provider: FiscalProvider | null
  environment: FiscalEnvironment
  has_provider_token: boolean
  provider_company_ref: string | null
  inscricao_estadual: string | null
  regime_tributario: RegimeTributario | null
  cnae: string | null
  fiscal_address: Record<string, unknown>
  invoice_sale_pct: number
  invoice_purchase_pct: number
  certificate_status: 'pending' | 'uploaded' | 'expired'
  certificate_expires_at: string | null
  is_active: boolean
}

/**
 * Faturador F1 — Fundação fiscal. Config de NF-e por empresa (CNPJ) + dados
 * fiscais por produto. O token do provedor é guardado CRIPTOGRAFADO via
 * CredentialsService (provider, key_name = company_id) — nunca em texto puro.
 * O certificado A1 vive no painel do provedor; aqui só marcamos o status.
 * NÃO emite NF-e (isso é F2+). Expõe readiness (o que falta pra poder emitir).
 */
@Injectable()
export class FulfillmentFiscalService {
  private readonly logger = new Logger(FulfillmentFiscalService.name)

  constructor(private readonly credentials: CredentialsService) {}

  // ── Config fiscal por empresa ───────────────────────────────────────────────
  async getCompanyFiscal(orgId: string, companyId: string): Promise<CompanyFiscalConfig | null> {
    const { data } = await supabaseAdmin
      .from('fiscal_company_config').select('*')
      .eq('organization_id', orgId).eq('company_id', companyId).maybeSingle()
    return (data as CompanyFiscalConfig | null) ?? null
  }

  async upsertCompanyFiscal(orgId: string, userId: string, companyId: string, input: {
    provider?: FiscalProvider | null; environment?: FiscalEnvironment; providerToken?: string | null
    providerCompanyRef?: string | null; inscricaoEstadual?: string | null; regimeTributario?: RegimeTributario | null
    cnae?: string | null; fiscalAddress?: Record<string, unknown>
    invoiceSalePct?: number; invoicePurchasePct?: number
    certificateStatus?: 'pending' | 'uploaded' | 'expired'; certificateExpiresAt?: string | null
  }): Promise<{ ok: true }> {
    // confirma empresa da org
    const { data: company } = await supabaseAdmin
      .from('fulfillment_companies').select('id').eq('id', companyId).eq('organization_id', orgId).maybeSingle()
    if (!company) throw new NotFoundException('Empresa não encontrada.')

    // token do provedor → cofre criptografado (não vai pra tabela)
    let hasToken: boolean | undefined
    if (input.providerToken !== undefined && input.provider) {
      if (input.providerToken && input.providerToken.trim()) {
        await this.credentials.saveCredential(orgId, userId, input.provider, companyId, input.providerToken.trim())
        hasToken = true
      }
    }

    const row: Record<string, unknown> = { organization_id: orgId, company_id: companyId }
    if (input.provider !== undefined) row.provider = input.provider
    if (input.environment !== undefined) row.environment = input.environment
    if (input.providerCompanyRef !== undefined) row.provider_company_ref = input.providerCompanyRef
    if (input.inscricaoEstadual !== undefined) row.inscricao_estadual = (input.inscricaoEstadual ?? '').toString().replace(/\D/g, '') || null
    if (input.regimeTributario !== undefined) row.regime_tributario = input.regimeTributario
    if (input.cnae !== undefined) row.cnae = input.cnae
    if (input.fiscalAddress !== undefined) row.fiscal_address = input.fiscalAddress
    if (input.invoiceSalePct !== undefined) row.invoice_sale_pct = clampPct(input.invoiceSalePct)
    if (input.invoicePurchasePct !== undefined) row.invoice_purchase_pct = clampPct(input.invoicePurchasePct)
    if (input.certificateStatus !== undefined) row.certificate_status = input.certificateStatus
    if (input.certificateExpiresAt !== undefined) row.certificate_expires_at = input.certificateExpiresAt
    if (hasToken !== undefined) row.has_provider_token = hasToken

    const { error } = await supabaseAdmin
      .from('fiscal_company_config').upsert(row, { onConflict: 'organization_id,company_id' })
    if (error) throw new BadRequestException(`Erro ao salvar config fiscal: ${error.message}`)
    return { ok: true }
  }

  // ── Certificado A1 (emissão DIRETA — nós assinamos, então guardamos o cert) ──
  /** Sobe o A1 (.pfx base64 + senha): valida abrindo o PKCS#12, lê validade/CN,
   *  e guarda CRIPTOGRAFADO no cofre (CredentialsService, provider 'sefaz_a1'). */
  async uploadCertificate(orgId: string, userId: string, companyId: string, input: { pfxBase64: string; password: string }): Promise<{ ok: true; expiresAt: string | null; subject: string | null }> {
    const { data: company } = await supabaseAdmin.from('fulfillment_companies').select('id').eq('id', companyId).eq('organization_id', orgId).maybeSingle()
    if (!company) throw new NotFoundException('Empresa não encontrada.')
    const b64 = (input.pfxBase64 ?? '').replace(/^data:[^;]*;base64,/, '').trim()
    if (!b64) throw new BadRequestException('Arquivo do certificado (.pfx) ausente.')

    let expiresAt: string | null = null
    let subject: string | null = null
    try {
      const der = forge.util.decode64(b64)
      const asn1 = forge.asn1.fromDer(der)
      const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, input.password ?? '')   // lança se a senha estiver errada
      const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
      const cert = certBags.map((b) => b.cert).find((c): c is forge.pki.Certificate => !!c)
      if (cert) {
        expiresAt = cert.validity?.notAfter ? new Date(cert.validity.notAfter).toISOString() : null
        const cn = cert.subject?.getField('CN') as { value?: string } | null
        subject = cn?.value ?? null
      }
    } catch {
      throw new BadRequestException('Não consegui abrir o certificado. Confirme que é um A1 (.pfx/.p12) válido e que a senha está correta.')
    }

    await this.credentials.saveCredential(orgId, userId, 'sefaz_a1', companyId, JSON.stringify({ pfxBase64: b64, password: input.password ?? '' }))
    const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false
    const { error } = await supabaseAdmin.from('fiscal_company_config').upsert(
      { organization_id: orgId, company_id: companyId, certificate_status: expired ? 'expired' : 'uploaded', certificate_expires_at: expiresAt },
      { onConflict: 'organization_id,company_id' },
    )
    if (error) throw new BadRequestException(`Erro ao salvar status do certificado: ${error.message}`)
    return { ok: true, expiresAt, subject }
  }

  /** Info do certificado pra UI (sem expor o arquivo/senha). */
  async getCertificateInfo(orgId: string, companyId: string): Promise<{ status: string; expiresAt: string | null; daysToExpire: number | null; hasFile: boolean }> {
    const cfg = await this.getCompanyFiscal(orgId, companyId)
    const expiresAt = cfg?.certificate_expires_at ?? null
    const days = expiresAt ? Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86400_000) : null
    const hasFile = !!(await this.credentials.getDecryptedKey(orgId, 'sefaz_a1', companyId))
    return { status: cfg?.certificate_status ?? 'pending', expiresAt, daysToExpire: days, hasFile }
  }

  /** Carrega o certificado descriptografado pra emissão (F2). Best-effort. */
  async loadCertificate(orgId: string, companyId: string): Promise<{ pfxBase64: string; password: string } | null> {
    const raw = await this.credentials.getDecryptedKey(orgId, 'sefaz_a1', companyId)
    if (!raw) return null
    try { return JSON.parse(raw) as { pfxBase64: string; password: string } } catch { return null }
  }

  // ── Numeração + regime ──────────────────────────────────────────────────────
  /** CRT do emitente na NF-e a partir do regime: MEI = 4 (NT 2023.001, vigente
   *  desde set/2024), Simples = 1, Presumido/Real = 3 (regime normal). */
  crtFor(regime: RegimeTributario | null | undefined): 1 | 3 | 4 {
    if (regime === 'mei') return 4
    if (regime === 'presumido' || regime === 'real') return 3
    return 1
  }

  /** Reserva ATÔMICA do próximo nNF da série (RPC fiscal_next_number — INSERT
   *  ON CONFLICT UPDATE num statement só). Numeração fiscal é sequencial e
   *  irreversível: número pulado exige inutilização na SEFAZ; por isso NUNCA
   *  gerar nNF por timestamp/MAX+1. Homologação e produção têm contadores
   *  separados (mesma série pode existir nos dois ambientes). */
  async nextInvoiceNumber(orgId: string, companyId: string, serie: number, ambiente: FiscalEnvironment): Promise<number> {
    const { data, error } = await supabaseAdmin.rpc('fiscal_next_number', {
      p_org: orgId, p_company: companyId, p_serie: serie, p_ambiente: ambiente,
    })
    if (error || data == null) throw new BadRequestException(`Não consegui reservar o número da NF-e: ${error?.message ?? 'RPC sem retorno'}`)
    return Number(data)
  }

  /** O que falta pra empresa poder emitir (usado pela UI + trava futura). */
  async readiness(orgId: string, companyId: string): Promise<{ ready: boolean; missing: string[] }> {
    const cfg = await this.getCompanyFiscal(orgId, companyId)
    const { data: company } = await supabaseAdmin
      .from('fulfillment_companies').select('cnpj').eq('id', companyId).eq('organization_id', orgId).maybeSingle()
    const missing: string[] = []
    if (!(company as { cnpj: string | null } | null)?.cnpj) missing.push('CNPJ da empresa')
    if (!cfg?.inscricao_estadual) missing.push('Inscrição Estadual')
    if (!cfg?.regime_tributario) missing.push('Regime tributário')
    if (cfg?.certificate_status !== 'uploaded') missing.push('Certificado A1')
    const addr = (cfg?.fiscal_address ?? {}) as Record<string, unknown>
    if (!addr.uf || !addr.city) missing.push('Endereço fiscal (cidade/UF)')
    if (!addr.logradouro || !addr.numero || !addr.bairro) missing.push('Endereço completo (logradouro/nº/bairro)')
    if (!addr.cMun || String(addr.cMun).replace(/\D/g, '').length !== 7) missing.push('Código IBGE do município')
    // Modo DIRETO (tem certificado) não usa provedor/token. Modo provedor (sem
    // cert) exige provedor + token.
    const directMode = cfg?.certificate_status === 'uploaded'
    if (!directMode) {
      if (!cfg?.provider) missing.push('Provedor de NF-e')
      if (!cfg?.has_provider_token) missing.push('Token do provedor')
    }
    return { ready: missing.length === 0, missing }
  }

  // ── Coletor de endereços da Shopee (F2b-4) ─────────────────────────────────
  /** Recebe os dados do comprador lidos no SELLER CENTER (get_one_order) e
   *  grava em `orders` no mesmo formato do sync — assim a emissão encontra o
   *  endereço pronto, sem ninguém digitar nada.
   *
   *  Por quê: a Open API da Shopee mascara `recipient_address` até o pedido ser
   *  DESPACHADO, mas despachar exige a NF-e. A tela do vendedor mostra tudo
   *  aberto; o coletor (bookmarklet) lê de lá e manda pra cá.
   *
   *  NUNCA sobrescreve valor aberto por vazio/mascarado. Idempotente. */
  async importShopeeAddresses(orgId: string, items: Array<{
    orderSn?: string; name?: string | null; doc?: string | null; addressLine?: string | null
  }>): Promise<{ ok: true; updated: number; skipped: number; errors: string[] }> {
    const errors: string[] = []
    let updated = 0, skipped = 0
    const cepCache = new Map<string, { bairro: string | null; ibge: string | null }>()

    for (const it of items ?? []) {
      const sn = String(it?.orderSn ?? '').trim()
      if (!sn) { skipped++; continue }
      try {
        const { data: rows } = await supabaseAdmin
          .from('orders').select('id, raw_data, buyer_name, buyer_doc_number')
          .eq('organization_id', orgId).eq('external_order_id', sn)
        if (!rows?.length) { errors.push(`${sn}: pedido não está no e-Click (sincronize a loja)`); continue }

        const parsed = parseSellerCenterAddress(it.addressLine ?? '')
        if (!parsed) { errors.push(`${sn}: não consegui interpretar o endereço`); continue }

        // ViaCEP completa o BAIRRO (o Seller Center não manda) e confere o município
        let extra = cepCache.get(parsed.cep)
        if (!extra) {
          extra = await lookupCep(parsed.cep)
          cepCache.set(parsed.cep, extra)
        }

        const doc = String(it.doc ?? '').replace(/\D/g, '')
        const name = openValue(it.name)

        for (const r of rows as Array<{ id: string; raw_data: Record<string, unknown> | null; buyer_name: string | null; buyer_doc_number: string | null }>) {
          const raw = (r.raw_data ?? {}) as Record<string, unknown>
          const prev = (raw.recipient_address ?? {}) as Record<string, unknown>
          const patch: Record<string, unknown> = {
            raw_data: {
              ...raw,
              recipient_address: {
                ...prev,
                name: name ?? prev.name ?? null,
                full_address: parsed.fullAddress,
                city: parsed.cidade,
                state: parsed.uf,
                district: extra.bairro ?? openValue(prev.district) ?? null,
                zipcode: parsed.cep,
              },
              // carimbo de origem — dado veio da tela do vendedor, não da Open API
              _endereco_via: 'seller_center',
            },
          }
          if (name) patch.buyer_name = name
          if (doc.length === 11 || doc.length === 14) patch.buyer_doc_number = doc
          const { error } = await supabaseAdmin.from('orders').update(patch).eq('id', r.id).eq('organization_id', orgId)
          if (error) throw new Error(error.message)
        }
        updated++
      } catch (e) {
        errors.push(`${sn}: ${(e as Error).message}`)
      }
    }
    this.logger.log(`[shopee-addr] org=${orgId} atualizados=${updated} pulados=${skipped} erros=${errors.length}`)
    return { ok: true, updated, skipped, errors }
  }

  /** % efetivo de uma CONTA (plataforma × conta): override da conta quando
   *  preenchido, senão o padrão da empresa dona da conta. Base pros valores das
   *  notas em F2/F4. */
  async getEffectivePct(orgId: string, accountId: string): Promise<{ salePct: number; purchasePct: number }> {
    const { data: acc } = await supabaseAdmin
      .from('fulfillment_accounts').select('company_id, invoice_sale_pct, invoice_purchase_pct')
      .eq('id', accountId).eq('organization_id', orgId).maybeSingle()
    const a = acc as { company_id: string | null; invoice_sale_pct: number | null; invoice_purchase_pct: number | null } | null
    let defSale = 100, defPurchase = 100
    if (a?.company_id) {
      const cfg = await this.getCompanyFiscal(orgId, a.company_id)
      if (cfg) { defSale = Number(cfg.invoice_sale_pct) || 100; defPurchase = Number(cfg.invoice_purchase_pct) || 100 }
    }
    return {
      salePct: a?.invoice_sale_pct != null ? Number(a.invoice_sale_pct) : defSale,
      purchasePct: a?.invoice_purchase_pct != null ? Number(a.invoice_purchase_pct) : defPurchase,
    }
  }

  /** Aplica a regra de % sobre o valor da venda (em centavos). Base pros valores
   *  das notas em F2/F4. Recebe os % já resolvidos (ver getEffectivePct). */
  computeInvoiceValues(saleValueCents: number, pct: { salePct: number; purchasePct: number }) {
    const sale = Math.round(saleValueCents * (Number(pct.salePct) || 100) / 100)
    const purchase = Math.round(saleValueCents * (Number(pct.purchasePct) || 100) / 100)
    return { saleValueCents: sale, purchaseValueCents: purchase }
  }

  // ── Dados fiscais por produto ────────────────────────────────────────────────
  /** Dados fiscais RESOLVIDOS por produto pra emissão: product_fiscal (painel do
   *  Faturador, canônico) com fallback em products.fiscal (jsonb do cadastro —
   *  vem do import/NF de compra). Devolve só os produtos que têm ALGUM dado. */
  async resolveProductFiscal(orgId: string, productIds: string[]): Promise<Map<string, {
    ncm: string | null; cest: string | null; origem: string | null
    cfop_sale: string | null; cst_csosn: string | null; unit: string; tax_rate: number | null
  }>> {
    const out = new Map<string, { ncm: string | null; cest: string | null; origem: string | null; cfop_sale: string | null; cst_csosn: string | null; unit: string; tax_rate: number | null }>()
    const ids = [...new Set(productIds.filter(Boolean))]
    if (ids.length === 0) return out
    const { data: rows } = await supabaseAdmin
      .from('product_fiscal').select('product_id, ncm, cest, origem, cfop_sale, cst_csosn, unit, tax_rate')
      .eq('organization_id', orgId).in('product_id', ids)
    for (const r of (rows ?? []) as Array<{ product_id: string; ncm: string | null; cest: string | null; origem: string | null; cfop_sale: string | null; cst_csosn: string | null; unit: string | null; tax_rate: number | null }>) {
      out.set(r.product_id, { ncm: r.ncm, cest: r.cest, origem: r.origem, cfop_sale: r.cfop_sale, cst_csosn: r.cst_csosn, unit: r.unit || 'UN', tax_rate: r.tax_rate })
    }
    const missing = ids.filter((id) => !out.get(id)?.ncm)
    if (missing.length > 0) {
      const { data: prods } = await supabaseAdmin
        .from('products').select('id, fiscal').eq('organization_id', orgId).in('id', missing)
      for (const p of (prods ?? []) as Array<{ id: string; fiscal: Record<string, string> | null }>) {
        if (!p.fiscal) continue
        const cur = out.get(p.id)
        const ncm = (p.fiscal.ncm ?? '').trim() || null
        if (!ncm && !cur) continue
        out.set(p.id, {
          ncm:       cur?.ncm ?? ncm,
          cest:      cur?.cest ?? ((p.fiscal.cest ?? '').trim() || null),
          origem:    cur?.origem ?? ((p.fiscal.origem ?? '').trim() || null),
          cfop_sale: cur?.cfop_sale ?? null,
          cst_csosn: cur?.cst_csosn ?? null,
          unit:      cur?.unit ?? 'UN',
          tax_rate:  cur?.tax_rate ?? null,
        })
      }
    }
    return out
  }

  async listProductFiscal(orgId: string) {
    const { data } = await supabaseAdmin
      .from('product_fiscal').select('*').eq('organization_id', orgId).order('updated_at', { ascending: false }).limit(500)
    return data ?? []
  }

  async upsertProductFiscal(orgId: string, productId: string, input: {
    ncm?: string | null; cest?: string | null; origem?: string | null
    cfop_sale?: string | null; cfop_transfer?: string | null; cst_csosn?: string | null
    unit?: string | null; tax_rate?: number | null
  }): Promise<{ ok: true }> {
    const { data: prod } = await supabaseAdmin
      .from('products').select('id').eq('id', productId).eq('organization_id', orgId).maybeSingle()
    if (!prod) throw new NotFoundException('Produto não encontrado.')
    const row: Record<string, unknown> = { organization_id: orgId, product_id: productId }
    for (const k of ['ncm', 'cest', 'origem', 'cfop_sale', 'cfop_transfer', 'cst_csosn', 'unit', 'tax_rate'] as const) {
      if (input[k] !== undefined) row[k] = input[k]
    }
    const { error } = await supabaseAdmin.from('product_fiscal').upsert(row, { onConflict: 'organization_id,product_id' })
    if (error) throw new BadRequestException(`Erro ao salvar fiscal do produto: ${error.message}`)
    return { ok: true }
  }
}

function clampPct(v: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 100
  return Math.min(Math.max(n, 0), 100)
}

// ── helpers do coletor de endereços ──────────────────────────────────────────

/** Valor "aberto" — a Shopee devolve `****` no lugar do dado quando mascara. */
function openValue(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && !/^\*+$/.test(s) ? s : null
}

const UF_POR_ESTADO: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE',
  'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA',
  'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
  paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
}

function ufFrom(v: string): string | null {
  const raw = String(v ?? '').trim()
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase()
  const key = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return UF_POR_ESTADO[key] ?? null
}

/** Quebra o endereço de LINHA ÚNICA do Seller Center. Formato observado:
 *  "Rua X, 765, Complemento, Cidade, Estado por extenso, 14037434"
 *  (o Seller Center NÃO manda o bairro — quem completa é o ViaCEP).
 *  Lê de trás pra frente: CEP → estado → cidade; o resto é logradouro/nº/compl. */
export function parseSellerCenterAddress(line: string): {
  logradouro: string; numero: string | null; complemento: string | null
  cidade: string; uf: string; cep: string; fullAddress: string
} | null {
  const src = String(line ?? '').trim()
  if (!src) return null
  const parts = src.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 4) return null

  const cep = (parts[parts.length - 1] ?? '').replace(/\D/g, '')
  if (cep.length !== 8) return null
  const uf = ufFrom(parts[parts.length - 2] ?? '')
  if (!uf) return null
  const cidade = parts[parts.length - 3] ?? ''
  if (!cidade) return null

  const resto = parts.slice(0, parts.length - 3)
  const logradouro = resto[0] ?? ''
  if (!logradouro) return null
  // 2º pedaço é o número quando for numérico; senão a rua fica sem número (S/N)
  const numMatch = /^(?:n[ºo°.]?\s*)?(\d{1,6}[a-zA-Z]?)$/.exec(resto[1] ?? '')
  const numero = numMatch ? numMatch[1] : null
  const complemento = resto.slice(numero ? 2 : 1).join(', ') || null

  return { logradouro, numero, complemento, cidade, uf, cep, fullAddress: src }
}

/** ViaCEP: bairro (o Seller Center não manda) + código IBGE do município.
 *  Best-effort — falha vira nulls e a emissão segue com o que tiver. */
async function lookupCep(cep: string): Promise<{ bairro: string | null; ibge: string | null }> {
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(8000) })
    const j = (await res.json()) as { bairro?: string; ibge?: string; erro?: boolean }
    if (j?.erro) return { bairro: null, ibge: null }
    return { bairro: openValue(j?.bairro), ibge: String(j?.ibge ?? '').replace(/\D/g, '') || null }
  } catch {
    return { bairro: null, ibge: null }
  }
}
