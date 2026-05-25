import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import * as forge from 'node-forge'
import { supabaseAdmin } from '../../common/supabase'
import { CredentialsService } from '../credentials/credentials.service'

export type FiscalProvider = 'nfeio' | 'focusnfe' | 'plugnotas' | 'erp_externo'
export type FiscalEnvironment = 'homologacao' | 'producao'
export type RegimeTributario = 'simples' | 'presumido' | 'real'

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

  /** O que falta pra empresa poder emitir (usado pela UI + trava futura). */
  async readiness(orgId: string, companyId: string): Promise<{ ready: boolean; missing: string[] }> {
    const cfg = await this.getCompanyFiscal(orgId, companyId)
    const { data: company } = await supabaseAdmin
      .from('fulfillment_companies').select('cnpj').eq('id', companyId).eq('organization_id', orgId).maybeSingle()
    const missing: string[] = []
    if (!(company as { cnpj: string | null } | null)?.cnpj) missing.push('CNPJ da empresa')
    if (!cfg?.provider) missing.push('Provedor de NF-e')
    if (!cfg?.has_provider_token) missing.push('Token do provedor')
    if (!cfg?.inscricao_estadual) missing.push('Inscrição Estadual')
    if (!cfg?.regime_tributario) missing.push('Regime tributário')
    if (cfg?.certificate_status !== 'uploaded') missing.push('Certificado A1 (enviar no painel do provedor)')
    const addr = (cfg?.fiscal_address ?? {}) as Record<string, unknown>
    if (!addr.uf || !addr.city) missing.push('Endereço fiscal (cidade/UF)')
    return { ready: missing.length === 0, missing }
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
