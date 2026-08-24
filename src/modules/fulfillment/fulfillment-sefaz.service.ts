import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import axios from 'axios'
import type { Tools } from 'node-sped-nfe'
import { supabaseAdmin } from '../../common/supabase'
import { FulfillmentFiscalService } from './fulfillment-fiscal.service'
import { FulfillmentInvoicesService } from './fulfillment-invoices.service'
import { FulfillmentService, marketplaceCustomer } from './fulfillment.service'
import { FULFILLMENT_BUCKET } from './fulfillment-labels.service'
import { CompositionService } from '../composition/composition.service'
import { ShopeeOrdersIngestionService } from '../marketplace/shopee-sync/shopee-orders-ingestion.service'
import { ShopeeProductSyncService } from '../marketplace/shopee-sync/shopee-product-sync.service'
import { MarketplaceService } from '../marketplace/marketplace.service'
import { MarketplaceAdapterRegistry } from '../marketplace/adapters/registry'
import { ShopeeAdapter } from '../marketplace/adapters/shopee.adapter'

// node-sped-nfe é ESM-only ("type":"module") e o backend é CommonJS. Carregamos
// via import() REAL — o `new Function` impede o TS de rebaixar pra require()
// (que daria ERR_REQUIRE_ESM em runtime). O `import type` acima é só tipo (apagado).
const loadSpedNfe = new Function('m', 'return import(m)') as (m: string) => Promise<typeof import('node-sped-nfe')>;

/**
 * Faturador F2 — emissão DIRETA na SEFAZ via node-sped-nfe (pura JS, sem Java).
 *
 * F2b-passo1: "Status do Serviço" — chamada simples que usa o certificado A1 do
 * cofre + a config da empresa pra bater na SEFAZ-SP (homologação/produção).
 * Prova de ponta a ponta que: a lib roda no servidor, o cert carrega/conecta, e
 * alcançamos a SEFAZ — ANTES de montar a NF-e completa (passo 2).
 */
@Injectable()
export class FulfillmentSefazService {
  private readonly logger = new Logger(FulfillmentSefazService.name)

  constructor(
    private readonly fiscal: FulfillmentFiscalService,
    private readonly invoices: FulfillmentInvoicesService,
    private readonly fulfillment: FulfillmentService,
    private readonly composition: CompositionService,
    private readonly shopeeOrders: ShopeeOrdersIngestionService,
    private readonly shopeeSync: ShopeeProductSyncService,   // ensureFreshToken
    private readonly mp: MarketplaceService,                 // conexão por loja
    private readonly registry: MarketplaceAdapterRegistry,   // adapter da plataforma
  ) {}

  /** Monta o Tools da node-sped-nfe. O .pfx é gravado num ARQUIVO temporário e
   *  passamos o CAMINHO (a lib/pem fazem `openssl pkcs12 -in <path>`; passar o
   *  base64 dá "File name too long"). Devolve cleanup pra apagar o temp. */
  private async toolsFor(orgId: string, companyId: string): Promise<{ tools: Tools; cleanup: () => void }> {
    const cfg = await this.fiscal.getCompanyFiscal(orgId, companyId)
    const cert = await this.fiscal.loadCertificate(orgId, companyId)
    if (!cert?.pfxBase64) throw new BadRequestException('Suba o certificado A1 da empresa antes de testar a conexão.')
    const { data: company } = await supabaseAdmin
      .from('fulfillment_companies').select('cnpj').eq('id', companyId).eq('organization_id', orgId).maybeSingle()
    const cnpj = ((company as { cnpj: string | null } | null)?.cnpj ?? '').replace(/\D/g, '')
    if (!cnpj) throw new BadRequestException('Preencha o CNPJ da empresa.')
    const addr = (cfg?.fiscal_address ?? {}) as Record<string, string>
    const uf = (addr.uf || 'SP').toUpperCase()
    const tpAmb = cfg?.environment === 'producao' ? 1 : 2

    const pfxPath = path.join(os.tmpdir(), `eclick-cert-${randomUUID()}.pfx`)
    fs.writeFileSync(pfxPath, Buffer.from(cert.pfxBase64, 'base64'), { mode: 0o600 })
    const cleanup = () => { try { fs.unlinkSync(pfxPath) } catch { /* noop */ } }

    const { Tools } = await loadSpedNfe('node-sped-nfe')
    const tools = new Tools(
      { mod: '55', xmllint: 'xmllint', UF: uf, tpAmb, CSC: '', CSCid: '', versao: '4.00', timeout: 30000, openssl: null, CPF: '', CNPJ: cnpj },
      { pfx: pfxPath, senha: cert.password },
    )
    return { tools, cleanup }
  }

  /** Status do Serviço na SEFAZ da UF da empresa. cStat 107 = serviço em operação. */
  async statusServico(orgId: string, companyId: string): Promise<{ ok: boolean; cStat: string | null; xMotivo: string | null; uf: string; ambiente: string }> {
    const cfg = await this.fiscal.getCompanyFiscal(orgId, companyId)
    const uf = ((cfg?.fiscal_address as Record<string, string> | undefined)?.uf || 'SP').toUpperCase()
    const ambiente = cfg?.environment === 'producao' ? 'produção' : 'homologação'
    let cleanup: (() => void) | null = null
    try {
      const t = await this.toolsFor(orgId, companyId)
      cleanup = t.cleanup
      const xml = await t.tools.sefazStatus()
      const cStat = /<cStat>(\d+)<\/cStat>/.exec(xml)?.[1] ?? null
      const xMotivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(xml)?.[1] ?? null
      return { ok: cStat === '107', cStat, xMotivo, uf, ambiente }
    } catch (e) {
      const msg = (e as Error).message || 'falha desconhecida'
      this.logger.warn(`[sefaz-status] org=${orgId} company=${companyId}: ${msg}`)
      throw new BadRequestException(`Não consegui falar com a SEFAZ-${uf} (${ambiente}): ${msg}`)
    } finally {
      if (cleanup) cleanup()
    }
  }

  /** Emite uma NF-e de TESTE (sempre homologação) — 1 produto genérico,
   *  destinatário de teste, CRT conforme o REGIME da empresa (MEI = 4).
   *  Numeração vem da fiscal_series (ambiente homologação tem contador
   *  próprio). Serve pra validar a emissão ponta a ponta.
   *
   *  ⚠️ EMISSÃO REAL DE PEDIDO (F2b-3): antes de montar make.tagProd(), os
   *  itens da invoice DEVEM passar por CompositionService.explodeForInvoice
   *  (módulo composition/) — SKU com composição (kit) é faturado pelos
   *  COMPONENTES (quantidade = qty × qtd_no_kit, valor rateado pelo preço de
   *  catálogo, total preservado), espelhando a baixa real de estoque. E venda
   *  intermediada por marketplace DEVE levar o grupo infIntermed (helper
   *  injectIntermed + INTERMEDIADORES abaixo) — NT 2020.006. */
  async emitTest(orgId: string, companyId: string): Promise<{ authorized: boolean; cStat: string | null; xMotivo: string | null; chave: string | null; protocolo: string | null }> {
    const cfg = await this.fiscal.getCompanyFiscal(orgId, companyId)
    const { data: company } = await supabaseAdmin
      .from('fulfillment_companies').select('name, cnpj').eq('id', companyId).eq('organization_id', orgId).maybeSingle()
    const c = company as { name: string; cnpj: string | null } | null
    const cnpj = (c?.cnpj ?? '').replace(/\D/g, '')
    const addr = (cfg?.fiscal_address ?? {}) as Record<string, string>
    const cMun = (addr.cMun || '').replace(/\D/g, '')
    // exige o mínimo que a SEFAZ valida no emitente
    const missing: string[] = []
    if (!cnpj) missing.push('CNPJ')
    if (!cfg?.inscricao_estadual) missing.push('Inscrição Estadual')
    if (!addr.logradouro) missing.push('Logradouro'); if (!addr.numero) missing.push('Número'); if (!addr.bairro) missing.push('Bairro')
    if (!cMun || cMun.length !== 7) missing.push('Código IBGE do município (7 díg.)')
    if (!addr.city) missing.push('Cidade'); if (!addr.uf) missing.push('UF'); if (!addr.cep) missing.push('CEP')
    if (missing.length) throw new BadRequestException(`Pra emitir, preencha no painel fiscal: ${missing.join(', ')}.`)

    const { tools, cleanup } = await this.toolsFor(orgId, companyId)
    try {
      const { Make } = await loadSpedNfe('node-sped-nfe')
      const make = new Make()
      const uf = addr.uf.toUpperCase()
      const cUF = Number(cMun.slice(0, 2))                    // 2 primeiros díg. do IBGE = código UF
      const cNF = String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
      // nNF sequencial da série (contador de HOMOLOGAÇÃO — separado do de produção)
      const nNF = await this.fiscal.nextInvoiceNumber(orgId, companyId, 1, 'homologacao')
      const crt = this.fiscal.crtFor(cfg?.regime_tributario)   // MEI=4 · Simples=1 · normal=3
      const dhEmi = brtNow()
      const ender = { xLgr: addr.logradouro, nro: addr.numero, xBairro: addr.bairro, cMun, xMun: addr.city, UF: uf, CEP: addr.cep.replace(/\D/g, ''), cPais: '1058', xPais: 'BRASIL' }

      make.tagInfNFe({ versao: '4.00' })
      // indPres 2 = venda pela internet (e-commerce); indFinal 1 = consumidor final
      // ⚠️ cDV vai AQUI (entre tpEmis e tpAmb): a lib escreve o <ide> na ordem das
      // chaves do objeto e só ATUALIZA o valor do cDV ao calcular a chave — sem o
      // placeholder na posição certa ele cai no fim do grupo e a SEFAZ rejeita (215).
      // indIntermed 0 = sem intermediador (o teste não passa por marketplace);
      // venda a consumidor final pela internet exige o campo (rejeição 434).
      make.tagIde({ cUF, cNF, natOp: 'VENDA DE MERCADORIA', mod: 55, serie: 1, nNF, dhEmi, tpNF: 1, idDest: 1, cMunFG: cMun, tpImp: 1, tpEmis: 1, cDV: 0, tpAmb: 2, finNFe: 1, indFinal: 1, indPres: 2, indIntermed: 0, procEmi: 0, verProc: 'eClick-1.0' })
      make.tagEmit({ CNPJ: cnpj, xNome: c?.name || 'EMITENTE TESTE', xFant: c?.name || 'EMITENTE', IE: (cfg!.inscricao_estadual ?? '').replace(/\D/g, ''), CRT: crt })
      make.tagEnderEmit(ender)
      // Em homologação a SEFAZ EXIGE este xNome literal no destinatário (senão rejeita)
      make.tagDest({ CPF: '11144477735', xNome: 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL', indIEDest: 9 })
      make.tagEnderDest(ender)
      // BA exige o grupo autXML (contador; sem contador = CNPJ da SEFAZ-BA) — rejeição 486
      if (AUTXML_POR_UF[uf]) make.tagAutXML({ CNPJ: AUTXML_POR_UF[uf] })
      await make.tagProd([{ cProd: 'TESTE001', cEAN: 'SEM GTIN', xProd: 'PRODUTO TESTE', NCM: '49011000', CFOP: '5102', uCom: 'UN', qCom: 1, vUnCom: 1.00, vProd: 1.00, cEANTrib: 'SEM GTIN', uTrib: 'UN', qTrib: 1, vUnTrib: 1.00, indTot: 1 }])
      make.tagProdICMSSN(0, { orig: '0', CSOSN: '102' })
      make.tagProdPIS(0, { CST: '49', vBC: '0.00', pPIS: '0.0000', vPIS: '0.00' })
      make.tagProdCOFINS(0, { CST: '49', vBC: '0.00', pCOFINS: '0.0000', vCOFINS: '0.00' })
      make.tagTotal({})          // {} = deixa a lib calcular os totais automaticamente
      make.tagTransp({ modFrete: '9' })
      // pagamento tem de BATER com o total da nota (tPag 90 + vPag 0 numa nota de R$1 = rejeição)
      make.tagDetPag([{ indPag: '0', tPag: '01', vPag: '1.00' }])
      make.tagInfRespTec({ CNPJ: cnpj, xContato: c?.name || 'Vazzo', email: 'vazzocomercio@gmail.com', fone: '1140000000' })

      const xml = make.xml()
      const signed = await tools.xmlSign(xml)
      // a lib tipa indSinc como literal 0; síncrono (1) é o que queremos pro teste
      const ret = await tools.sefazEnviaLote(signed, { idLote: 1, indSinc: 1, compactar: false } as unknown as { idLote?: 1; indSinc?: 0; compactar?: false })
      const { cStat, xMotivo, chave, protocolo } = parseRetornoSefaz(ret)
      this.logger.log(`[emit-test] org=${orgId} company=${companyId} nNF=${nNF} cStat=${cStat} ${xMotivo}`)
      return { authorized: cStat === '100', cStat, xMotivo, chave, protocolo }
    } catch (e) {
      const msg = (e as Error).message || JSON.stringify(e)
      this.logger.warn(`[emit-test] org=${orgId} company=${companyId}: ${msg}`)
      throw new BadRequestException(`Falha ao emitir NF-e de teste: ${msg}`)
    } finally {
      cleanup()
    }
  }

  /** F2b-3 — Emissão REAL: NF-e de venda de um pedido de marketplace.
   *
   *  Pipeline: linhas de `orders` → (Shopee) re-ingestão AO VIVO do pedido
   *  (ingestSingleOrder busca CPF/endereço abertos pela etiqueta — a janela
   *  READY_TO_SHIP é curta e o espelho quase sempre está mascarado) →
   *  destinatário completo → kits explodidos em componentes → dados fiscais
   *  por produto (product_fiscal + fallback) → XML com grupo do intermediador
   *  (NT 2020.006) → assina → SEFAZ → grava invoice + XML no storage.
   *
   *  `dryRun: true` monta e devolve o XML SEM reservar número, assinar ou
   *  enviar — validação ponta a ponta antes do certificado A1 existir. */
  async emitForOrder(orgId: string, externalOrderId: string, opts?: { dryRun?: boolean; dest?: DestOverride }): Promise<{
    authorized: boolean; dryRun?: boolean; cStat: string | null; xMotivo: string | null
    chave: string | null; protocolo: string | null; nNF: number | null; serie: number
    invoiceId?: string; xml?: string
    /** resultado do envio automático da nota pro marketplace (F2b-6) */
    marketplace?: { ok: boolean; erro?: string }
  }> {
    const dryRun = !!opts?.dryRun
    const serie = 1

    // ── 1. pedido ──────────────────────────────────────────────────────────
    let rows = await this.orderRows(orgId, externalOrderId)
    if (rows.length === 0) throw new NotFoundException('Pedido não encontrado em orders (sincronize a loja primeiro).')
    if (rows[0].status === 'cancelled') throw new BadRequestException('Pedido cancelado — não emitir NF-e.')
    const platform = rows[0].platform ?? ''
    const shopId = rows[0].channel_account_id

    // ── 2. Shopee: refresh AO VIVO (CPF/endereço abertos via etiqueta) ─────
    if (platform === 'shopee' && shopId) {
      try {
        await this.shopeeOrders.ingestSingleOrder(orgId, shopId, externalOrderId)
        rows = await this.orderRows(orgId, externalOrderId)
      } catch (e) {
        this.logger.warn(`[emit-order] refresh Shopee ${externalOrderId} falhou (sigo com o espelho): ${(e as Error).message}`)
      }
    }

    // ── 3. conta → empresa emissora → config ───────────────────────────────
    const { data: accRow } = await supabaseAdmin
      .from('fulfillment_accounts').select('id, label, company_id')
      .eq('organization_id', orgId).eq('platform', platform || 'mercadolivre')
      .eq('external_account_id', String(shopId ?? rows[0].seller_id ?? '')).maybeSingle()
    const acc = accRow as { id: string; label: string | null; company_id: string | null } | null
    if (!acc?.company_id) throw new BadRequestException('Conta do pedido sem empresa emissora vinculada (Fulfillment → Contas).')
    const companyId = acc.company_id
    const cfg = await this.fiscal.getCompanyFiscal(orgId, companyId)
    if (!cfg) throw new BadRequestException('Empresa emissora sem config fiscal.')
    if (cfg.regime_tributario === 'presumido' || cfg.regime_tributario === 'real') {
      throw new BadRequestException('Emissão pra regime normal (presumido/real) ainda não suportada — só Simples/MEI.')
    }
    const { data: companyRow } = await supabaseAdmin
      .from('fulfillment_companies').select('name, cnpj').eq('id', companyId).eq('organization_id', orgId).maybeSingle()
    const company = companyRow as { name: string; cnpj: string | null } | null
    const emitCnpj = (company?.cnpj ?? '').replace(/\D/g, '')
    const eAddr = (cfg.fiscal_address ?? {}) as Record<string, string>
    const eCMun = (eAddr.cMun || '').replace(/\D/g, '')
    const missing: string[] = []
    if (!emitCnpj) missing.push('CNPJ')
    if (!cfg.inscricao_estadual) missing.push('Inscrição Estadual')
    if (!eAddr.logradouro || !eAddr.numero || !eAddr.bairro) missing.push('Endereço do emitente')
    if (!eCMun || eCMun.length !== 7) missing.push('Código IBGE do emitente')
    if (!eAddr.city || !eAddr.uf || !eAddr.cep) missing.push('Cidade/UF/CEP do emitente')
    if (missing.length) throw new BadRequestException(`Complete o painel fiscal da empresa: ${missing.join(', ')}.`)

    // ── 4. destinatário — capturado na janela aberta, com override manual ──
    // A Shopee mascara o endereço na API até a etiqueta ser gerada (mas exige a
    // NF pra deixar gerar). O `dest` deixa informar o que aparece no Seller
    // Center; cada campo do override tem prioridade sobre o capturado.
    const cust = marketplaceCustomer(rows[0])
    const ov = opts?.dest
    const doc = String(ov?.doc ?? cust.doc ?? '').replace(/\D/g, '')
    if (doc.length !== 11 && doc.length !== 14) {
      throw new BadRequestException('CPF/CNPJ do comprador ainda não capturado. Informe o CPF/CNPJ do destinatário (visível no detalhe do pedido na Shopee).')
    }
    const capAddr = (cust.address ?? {}) as { logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null; cep?: string | null }
    const dAddr = {
      logradouro: ov?.logradouro ?? capAddr.logradouro ?? null,
      numero: ov?.numero ?? capAddr.numero ?? null,
      complemento: ov?.complemento ?? capAddr.complemento ?? null,
      bairro: ov?.bairro ?? capAddr.bairro ?? null,
      cidade: ov?.cidade ?? capAddr.cidade ?? null,
      uf: ov?.uf ?? capAddr.uf ?? null,
      cep: ov?.cep ?? capAddr.cep ?? null,
    }
    const destName = ov?.name ?? (cust.name as string | undefined)
    const dCep = String(dAddr.cep ?? '').replace(/\D/g, '')
    if (!dAddr.logradouro || !dAddr.cidade || !dAddr.uf || dCep.length !== 8) {
      throw new BadRequestException('ENDERECO_INCOMPLETO: A Shopee mascarou o endereço (ela só abre depois de organizar o envio). Informe o endereço do comprador — ele aparece no detalhe do pedido na Shopee.')
    }
    // cMun do DESTINATÁRIO via ViaCEP; o bairro também vem de lá quando falta
    // (o Seller Center não manda bairro na linha do endereço)
    const cepInfo = await this.resolveIbgeByCep(dCep)
    const dCMun = cepInfo.ibge
    const dBairro = dAddr.bairro ?? cepInfo.bairro ?? 'CENTRO'

    // ── 5. itens: valor PAGO → % da conta → kits explodidos → fiscal ───────
    const pct = await this.fiscal.getEffectivePct(orgId, acc.id)
    const fator = (Number(pct.salePct) || 100) / 100

    // `orders.sale_price` é o preço do ITEM; o comprador pode ter pago MENOS
    // (cupom/voucher da plataforma). A nota tem de refletir o valor PAGO —
    // senão sai maior que a operação real e o pagamento declarado não fecha.
    // Rateia a diferença proporcionalmente entre as linhas do pedido.
    const somaItens = rows.reduce((s, r) => s + (Number(r.sale_price) || 0), 0)
    const pago = Number((rows[0].raw_data as { total_amount?: unknown } | null)?.total_amount)
    const ajuste = Number.isFinite(pago) && pago > 0 && somaItens > 0 ? pago / somaItens : 1
    if (ajuste !== 1) {
      this.logger.log(`[emit-order] ${externalOrderId} valor pago R$${pago.toFixed(2)} vs itens R$${somaItens.toFixed(2)} — rateando desconto (fator ${ajuste.toFixed(4)})`)
    }

    const lines = rows.map((r) => ({
      product_id: r.product_id, sku: r.sku, description: r.product_title,
      qty: Number(r.quantity) || 1,
      unit_value: round4(((Number(r.sale_price) || 0) * ajuste * fator) / (Number(r.quantity) || 1)),
    }))
    const exploded = await this.composition.explodeForInvoice(orgId, lines)
    const pids = [...new Set(exploded.map((l) => l.product_id).filter((v): v is string => !!v))]
    const fiscalMap = await this.fiscal.resolveProductFiscal(orgId, pids)
    const { data: prodRows } = await supabaseAdmin
      .from('products').select('id, ean').eq('organization_id', orgId).in('id', pids.length ? pids : ['00000000-0000-0000-0000-000000000000'])
    const eanById = new Map((prodRows ?? []).map((p) => [(p as { id: string }).id, (p as { ean: string | null }).ean]))
    const semNcm = exploded.filter((l) => !l.product_id || !fiscalMap.get(l.product_id)?.ncm)
    if (semNcm.length) throw new BadRequestException(`Produto(s) sem NCM cadastrado: ${semNcm.map((l) => l.sku ?? '?').join(', ')} — preencha em Fulfillment → Fiscal.`)

    const sameUf = (dAddr.uf ?? '').toUpperCase() === eAddr.uf.toUpperCase()
    const items = exploded.map((l) => {
      const f = fiscalMap.get(l.product_id!)!
      const qty = Number(l.qty) || 1
      const vUn = round4(Number(l.unit_value) || 0)
      const cfopIntra = f.cfop_sale ?? '5102'
      // interestadual a consumidor final não contribuinte: 5102→6108; demais 5xxx→6xxx
      const cfop = sameUf ? cfopIntra : (cfopIntra === '5102' ? '6108' : '6' + cfopIntra.slice(1))
      const ean = eanById.get(l.product_id!) ?? null
      return {
        cProd: String(l.sku ?? l.product_id).slice(0, 60),
        cEAN: ean || 'SEM GTIN',
        xProd: String(l.description ?? l.sku ?? 'PRODUTO').slice(0, 120),
        NCM: f.ncm!, CFOP: cfop, uCom: f.unit || 'UN',
        qCom: qty, vUnCom: vUn, vProd: round2(qty * vUn),
        cEANTrib: ean || 'SEM GTIN', uTrib: f.unit || 'UN', qTrib: qty, vUnTrib: vUn,
        indTot: 1,
        _orig: f.origem ?? '0', _csosn: f.cst_csosn ?? '102',
      }
    })
    const total = round2(items.reduce((s, i) => s + i.vProd, 0))
    if (total <= 0) throw new BadRequestException('Total da nota deu zero — confira os valores do pedido.')

    // ── 6. duplicidade: já existe NF emitida pra este pedido? ──────────────
    const fo = await this.ensureFulfillmentOrder(orgId, externalOrderId, dryRun)
    if (fo) {
      const { data: dup } = await supabaseAdmin
        .from('fulfillment_invoices').select('id, number, access_key')
        .eq('organization_id', orgId).eq('fulfillment_order_id', fo)
        .eq('kind', 'venda').eq('status', 'issued').limit(1).maybeSingle()
      if (dup) {
        const d = dup as { id: string; number: string | null; access_key: string | null }
        throw new BadRequestException(`Este pedido JÁ tem NF-e emitida (nº ${d.number ?? '?'}, chave ${d.access_key ?? '?'}). Cancele antes de reemitir.`)
      }
    }

    // ── 7. montar o XML ────────────────────────────────────────────────────
    const ambiente = cfg.environment === 'producao' ? 'producao' : 'homologacao'
    const tpAmb = ambiente === 'producao' ? 1 : 2
    const nNF = dryRun ? 99999999 : await this.fiscal.nextInvoiceNumber(orgId, companyId, serie, ambiente as 'homologacao' | 'producao')
    const crt = this.fiscal.crtFor(cfg.regime_tributario)
    const cNF = String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
    const uf = eAddr.uf.toUpperCase()
    const cUF = Number(eCMun.slice(0, 2))
    const enderEmit = { xLgr: eAddr.logradouro, nro: eAddr.numero, xBairro: eAddr.bairro, cMun: eCMun, xMun: eAddr.city, UF: uf, CEP: eAddr.cep.replace(/\D/g, ''), cPais: '1058', xPais: 'BRASIL' }
    const enderDest = {
      xLgr: String(dAddr.logradouro).slice(0, 60), nro: String(dAddr.numero ?? 'S/N').slice(0, 60),
      ...(dAddr.complemento ? { xCpl: String(dAddr.complemento).slice(0, 60) } : {}),
      xBairro: String(dBairro).slice(0, 60), cMun: dCMun,
      xMun: String(dAddr.cidade).slice(0, 60), UF: (dAddr.uf ?? '').toUpperCase(), CEP: dCep, cPais: '1058', xPais: 'BRASIL',
    }

    const intermed = INTERMEDIADORES[platform]
    const { Make } = await loadSpedNfe('node-sped-nfe')
    const make = new Make()
    make.tagInfNFe({ versao: '4.00' })
    // cDV entre tpEmis e tpAmb (rejeição 215); indIntermed obrigatório em venda a
    // consumidor final pela internet (rejeição 434): 1 = com marketplace, 0 = sem.
    make.tagIde({ cUF, cNF, natOp: 'VENDA DE MERCADORIA', mod: 55, serie, nNF, dhEmi: brtNow(), tpNF: 1, idDest: sameUf ? 1 : 2, cMunFG: eCMun, tpImp: 1, tpEmis: 1, cDV: 0, tpAmb, finNFe: 1, indFinal: 1, indPres: 2, indIntermed: intermed ? 1 : 0, procEmi: 0, verProc: 'eClick-1.0' })
    make.tagEmit({ CNPJ: emitCnpj, xNome: company?.name || 'EMITENTE', xFant: company?.name || 'EMITENTE', IE: (cfg.inscricao_estadual ?? '').replace(/\D/g, ''), CRT: crt })
    make.tagEnderEmit(enderEmit)
    // homologação EXIGE este xNome literal; produção leva o nome real
    const destNome = tpAmb === 2 ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : String(destName ?? 'CONSUMIDOR').slice(0, 60)
    make.tagDest({ ...(doc.length === 14 ? { CNPJ: doc } : { CPF: doc }), xNome: destNome, indIEDest: 9 })
    make.tagEnderDest(enderDest)
    // BA exige o grupo autXML (contador; sem contador = CNPJ da SEFAZ-BA) — rejeição 486
    if (AUTXML_POR_UF[uf]) make.tagAutXML({ CNPJ: AUTXML_POR_UF[uf] })
    await make.tagProd(items.map(({ _orig, _csosn, ...rest }) => rest))
    items.forEach((it, idx) => {
      make.tagProdICMSSN(idx, { orig: it._orig, CSOSN: it._csosn })
      make.tagProdPIS(idx, { CST: '49', vBC: '0.00', pPIS: '0.0000', vPIS: '0.00' })
      make.tagProdCOFINS(idx, { CST: '49', vBC: '0.00', pCOFINS: '0.0000', vCOFINS: '0.00' })
    })
    make.tagTotal({})
    make.tagTransp({ modFrete: '9' })   // frete contratado/gerido pela plataforma — sem frete próprio na nota
    make.tagDetPag([{ indPag: '0', tPag: '99', xPag: 'Pagamento intermediado por marketplace', vPag: total.toFixed(2) }])
    make.tagInfRespTec({ CNPJ: emitCnpj, xContato: company?.name || 'Vazzo', email: 'vazzocomercio@gmail.com', fone: '7199372247' })

    let xml = make.xml()
    // venda intermediada (NT 2020.006) — grupo infIntermed (indIntermed=1 já no <ide>)
    if (intermed) xml = injectIntermed(xml, { cnpj: intermed.cnpj, idCadIntTran: acc.label ?? intermed.nome })

    if (dryRun) {
      this.logger.log(`[emit-order] DRY-RUN ${externalOrderId} total=R$${total.toFixed(2)} itens=${items.length} amb=${ambiente}`)
      return { authorized: false, dryRun: true, cStat: null, xMotivo: `dry-run OK — ${items.length} item(ns), total R$ ${total.toFixed(2)}, ${ambiente}`, chave: null, protocolo: null, nNF: null, serie, xml }
    }

    // ── 8. assinar, enviar, registrar ──────────────────────────────────────
    const { tools, cleanup } = await this.toolsFor(orgId, companyId)
    try {
      const signed = await tools.xmlSign(xml)
      const ret = await tools.sefazEnviaLote(signed, { idLote: 1, indSinc: 1, compactar: false } as unknown as { idLote?: 1; indSinc?: 0; compactar?: false })
      const { cStat, xMotivo, chave, protocolo } = parseRetornoSefaz(ret)
      this.logger.log(`[emit-order] ${externalOrderId} nNF=${nNF} cStat=${cStat} ${xMotivo}`)

      let invoiceId: string | undefined
      let marketplace: { ok: boolean; erro?: string } | undefined
      if (cStat === '100' && chave) {
        // guarda os 3 XMLs (obrigação de 5 anos). O que o marketplace/contador
        // aceita é o nfeProc — nota assinada + protocolo no MESMO arquivo;
        // mandar só o <NFe> dá "Invalid NF-e" na Shopee (visto ao vivo 24/08).
        const base = `${orgId}/invoices/${chave}`
        const proc = montarNfeProc(signed, ret)
        const up = (nome: string, conteudo: string) => supabaseAdmin.storage.from(FULFILLMENT_BUCKET)
          .upload(`${base}${nome}`, Buffer.from(conteudo, 'utf8'), { contentType: 'application/xml', upsert: true })
        await up('-nfe.xml', signed)
        await up('-prot.xml', ret)
        if (proc) await up('-procNFe.xml', proc)

        const foId = fo ?? await this.ensureFulfillmentOrder(orgId, externalOrderId, false)
        if (foId) {
          const r = await this.invoices.upsertForOrder(orgId, foId, {
            companyId, kind: 'venda', status: 'issued',
            number: String(nNF), series: String(serie), accessKey: chave,
            xmlUrl: `${base}-nfe.xml`, provider: 'sefaz_direto',
            items: exploded.map((l) => ({ sku: String(l.sku ?? ''), description: l.description ?? null, qty: Number(l.qty) || 0, unit_value: l.unit_value ?? null })),
          })
          invoiceId = r.id
          if (proc) {
            await supabaseAdmin.from('fulfillment_invoices')
              .update({ proc_xml_url: `${base}-procNFe.xml` }).eq('id', r.id).eq('organization_id', orgId)
          }
        }

        // F2b-6 — devolve a nota pro marketplace (destrava o "Organizar Envio").
        // Best-effort: a nota JÁ existe na SEFAZ; falha aqui vira pendência de
        // reenvio, nunca desfaz a emissão.
        marketplace = await this.enviarNotaProMarketplace(orgId, {
          invoiceId, platform, shopId, orderSn: externalOrderId,
          number: String(nNF), serie: String(serie), chave, total,
        })
      }
      return { authorized: cStat === '100', cStat, xMotivo, chave, protocolo, nNF, serie, invoiceId, marketplace }
    } catch (e) {
      const msg = (e as Error).message || JSON.stringify(e)
      this.logger.warn(`[emit-order] ${externalOrderId}: ${msg}`)
      throw new BadRequestException(`Falha ao emitir NF-e do pedido ${externalOrderId}: ${msg}`)
    } finally {
      cleanup()
    }
  }

  // ── F2b-7: eventos da nota (cancelamento e carta de correção) ────────────

  /** CANCELA uma NF-e autorizada (evento 110111).
   *
   *  ⚠️ Prazo legal: 24h da autorização na maioria das UFs — passou disso, a
   *  SEFAZ recusa e o caminho vira devolução/nota de entrada (com o contador).
   *  A justificativa é obrigatória e vai NO EVENTO público: mínimo 15 chars.
   *  Cancelar NÃO reabre a numeração — o número fica queimado, é assim mesmo. */
  async cancelarNota(orgId: string, input: { invoiceId?: string; accessKey?: string; justificativa: string }): Promise<{
    cancelada: boolean; cStat: string | null; xMotivo: string | null; protocolo: string | null
  }> {
    const just = String(input.justificativa ?? '').trim()
    if (just.length < 15) throw new BadRequestException('A justificativa do cancelamento precisa de pelo menos 15 caracteres (exigência da SEFAZ).')
    if (just.length > 255) throw new BadRequestException('Justificativa muito longa (máx. 255 caracteres).')

    let q = supabaseAdmin.from('fulfillment_invoices')
      .select('id, number, series, access_key, status, company_id, fulfillment_order_id')
      .eq('organization_id', orgId)
    q = input.invoiceId ? q.eq('id', input.invoiceId) : q.eq('access_key', (input.accessKey ?? '').replace(/\D/g, ''))
    const { data: row } = await q.limit(1).maybeSingle()
    const inv = row as { id: string; number: string | null; series: string | null; access_key: string | null; status: string; company_id: string | null } | null
    if (!inv) throw new NotFoundException('Nota não encontrada.')
    if (inv.status === 'cancelled') throw new BadRequestException('Esta nota já está cancelada.')
    if (inv.status !== 'issued' || !inv.access_key) throw new BadRequestException('Só dá pra cancelar nota emitida e autorizada.')
    if (!inv.company_id) throw new BadRequestException('Nota sem empresa emissora — não consigo carregar o certificado.')

    // o protocolo de autorização é obrigatório no evento; sai do XML guardado
    const protocolo = await this.protocoloDaNota(orgId, inv.access_key)
    if (!protocolo) throw new BadRequestException('Não achei o protocolo de autorização desta nota (necessário pro cancelamento).')

    const { tools, cleanup } = await this.toolsFor(orgId, inv.company_id)
    try {
      const ret = await tools.sefazEvento({ chNFe: inv.access_key, tpEvento: '110111', nProt: protocolo, xJust: just, nSeqEvento: 1 })
      // 135 = evento registrado e vinculado · 155 = registrado fora de prazo (também cancela)
      const cStat = /<cStat>(\d+)<\/cStat>/g.exec(ret)?.[1] ?? null
      const xMotivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(ret)?.[1] ?? null
      const protEvento = /<nProt>(\d+)<\/nProt>/.exec(ret)?.[1] ?? null
      const okStats = ['135', '155']
      const cStatEvento = /<retEvento[\s\S]*?<cStat>(\d+)<\/cStat>/.exec(ret)?.[1] ?? cStat
      const cancelada = okStats.includes(String(cStatEvento))

      // guarda o XML do evento (faz parte da escrituração)
      await supabaseAdmin.storage.from(FULFILLMENT_BUCKET)
        .upload(`${orgId}/invoices/${inv.access_key}-cancelamento.xml`, Buffer.from(ret, 'utf8'), { contentType: 'application/xml', upsert: true })

      if (cancelada) {
        await supabaseAdmin.from('fulfillment_invoices')
          .update({ status: 'cancelled', cancel_reason: just, cancelled_at: new Date().toISOString() })
          .eq('id', inv.id).eq('organization_id', orgId)
      }
      this.logger.log(`[cancelar-nf] NF ${inv.number} chave=${inv.access_key} cStat=${cStatEvento} ${xMotivo}`)
      return { cancelada, cStat: cStatEvento, xMotivo, protocolo: protEvento }
    } catch (e) {
      const msg = (e as Error).message || JSON.stringify(e)
      this.logger.warn(`[cancelar-nf] ${inv.access_key}: ${msg}`)
      throw new BadRequestException(`Falha ao cancelar a NF-e: ${msg}`)
    } finally {
      cleanup()
    }
  }

  /** CARTA DE CORREÇÃO (evento 110110) — conserta erro que NÃO seja de valor,
   *  imposto, quantidade, data ou troca de destinatário (esses só cancelando).
   *  Serve pra endereço/observação. Cada CC-e é uma sequência nova. */
  async cartaDeCorrecao(orgId: string, input: { invoiceId?: string; accessKey?: string; correcao: string }): Promise<{
    ok: boolean; cStat: string | null; xMotivo: string | null; sequencia: number
  }> {
    const texto = String(input.correcao ?? '').trim()
    if (texto.length < 15) throw new BadRequestException('A correção precisa de pelo menos 15 caracteres (exigência da SEFAZ).')
    if (texto.length > 1000) throw new BadRequestException('Correção muito longa (máx. 1000 caracteres).')

    let q = supabaseAdmin.from('fulfillment_invoices')
      .select('id, number, access_key, status, company_id, cce_count').eq('organization_id', orgId)
    q = input.invoiceId ? q.eq('id', input.invoiceId) : q.eq('access_key', (input.accessKey ?? '').replace(/\D/g, ''))
    const { data: row } = await q.limit(1).maybeSingle()
    const inv = row as { id: string; number: string | null; access_key: string | null; status: string; company_id: string | null; cce_count: number | null } | null
    if (!inv?.access_key) throw new NotFoundException('Nota não encontrada.')
    if (inv.status !== 'issued') throw new BadRequestException('Carta de correção só vale pra nota autorizada (não cancelada).')
    if (!inv.company_id) throw new BadRequestException('Nota sem empresa emissora.')

    const seq = (Number(inv.cce_count) || 0) + 1
    const { tools, cleanup } = await this.toolsFor(orgId, inv.company_id)
    try {
      const ret = await tools.sefazEvento({ chNFe: inv.access_key, tpEvento: '110110', xJust: texto, nSeqEvento: seq })
      const cStat = /<retEvento[\s\S]*?<cStat>(\d+)<\/cStat>/.exec(ret)?.[1] ?? /<cStat>(\d+)<\/cStat>/.exec(ret)?.[1] ?? null
      const xMotivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(ret)?.[1] ?? null
      const ok = ['135', '136'].includes(String(cStat))
      await supabaseAdmin.storage.from(FULFILLMENT_BUCKET)
        .upload(`${orgId}/invoices/${inv.access_key}-cce-${seq}.xml`, Buffer.from(ret, 'utf8'), { contentType: 'application/xml', upsert: true })
      if (ok) {
        await supabaseAdmin.from('fulfillment_invoices').update({ cce_count: seq }).eq('id', inv.id).eq('organization_id', orgId)
      }
      this.logger.log(`[cce] NF ${inv.number} seq=${seq} cStat=${cStat} ${xMotivo}`)
      return { ok, cStat, xMotivo, sequencia: seq }
    } catch (e) {
      const msg = (e as Error).message || JSON.stringify(e)
      throw new BadRequestException(`Falha na carta de correção: ${msg}`)
    } finally {
      cleanup()
    }
  }

  /** Protocolo de autorização da nota — lê do XML de retorno guardado. */
  private async protocoloDaNota(orgId: string, chave: string): Promise<string | null> {
    for (const suf of ['-prot.xml', '-procNFe.xml']) {
      const { data } = await supabaseAdmin.storage.from(FULFILLMENT_BUCKET).download(`${orgId}/invoices/${chave}${suf}`)
      if (!data) continue
      const txt = await data.text()
      const nProt = /<nProt>(\d+)<\/nProt>/.exec(txt)?.[1]
      if (nProt) return nProt
    }
    return null
  }

  /** FILA FISCAL — pedidos na janela de despacho e o que falta em cada um pra
   *  virar nota. É a tela de trabalho do dia: o operador olha o semáforo,
   *  resolve o que está vermelho e manda emitir o lote. */
  async filaFiscal(orgId: string): Promise<{
    pedidos: Array<{
      orderSn: string; comprador: string | null; valor: number; loja: string | null
      temEndereco: boolean; temDoc: boolean; semNcm: string[]
      nota: { id: string; number: string | null; chave: string | null; noMarketplace: boolean; podeCancelar: boolean; horasPraCancelar: number | null } | null
      pronto: boolean; falta: string[]
    }>
    resumo: { total: number; prontos: number; jaEmitidos: number; bloqueados: number }
  }> {
    // pedidos pagos ainda não despachados = janela em que a nota é necessária
    const { data: rows } = await supabaseAdmin
      .from('orders')
      .select('external_order_id, product_id, sku, quantity, sale_price, buyer_name, buyer_doc_number, buyer_phone, raw_data, channel_account_id, platform, shipping_status, status')
      .eq('organization_id', orgId).eq('status', 'paid')
      .in('shipping_status', ['ready_to_ship', 'processed', 'pending'])
      .order('sold_at', { ascending: true }).limit(500)
    const porPedido = new Map<string, typeof rows>()
    for (const r of (rows ?? []) as NonNullable<typeof rows>) {
      const k = (r as { external_order_id: string }).external_order_id
      if (!porPedido.has(k)) porPedido.set(k, [] as unknown as typeof rows)
      ;(porPedido.get(k) as unknown as Array<unknown>).push(r)
    }
    if (porPedido.size === 0) return { pedidos: [], resumo: { total: 0, prontos: 0, jaEmitidos: 0, bloqueados: 0 } }

    // notas já emitidas destes pedidos
    const sns = [...porPedido.keys()]
    const { data: fos } = await supabaseAdmin
      .from('fulfillment_orders').select('id, source_id')
      .eq('organization_id', orgId).eq('source_type', 'marketplace').in('source_id', sns)
    const foBySn = new Map((fos ?? []).map((f) => [(f as { source_id: string }).source_id, (f as { id: string }).id]))
    const { data: invs } = await supabaseAdmin
      .from('fulfillment_invoices').select('id, fulfillment_order_id, number, access_key, marketplace_sent_at, status, created_at')
      .eq('organization_id', orgId).eq('status', 'issued')
      .in('fulfillment_order_id', [...foBySn.values()].length ? [...foBySn.values()] : ['00000000-0000-0000-0000-000000000000'])
    const invByFo = new Map((invs ?? []).map((i) => [(i as { fulfillment_order_id: string }).fulfillment_order_id, i as { id: string; number: string | null; access_key: string | null; marketplace_sent_at: string | null; created_at: string }]))

    // fiscal de todos os produtos envolvidos, de uma vez
    const pids = [...new Set((rows ?? []).map((r) => (r as { product_id: string | null }).product_id).filter((v): v is string => !!v))]
    const fiscalMap = await this.fiscal.resolveProductFiscal(orgId, pids)

    const pedidos = [] as Awaited<ReturnType<typeof this.filaFiscal>>['pedidos']
    for (const [orderSn, linhas] of porPedido) {
      const ls = linhas as unknown as Array<{ product_id: string | null; sku: string; sale_price: number | null; buyer_name: string | null; buyer_doc_number: string | null; buyer_phone: string | null; raw_data: Record<string, unknown> | null; channel_account_id: string | null }>
      const cust = marketplaceCustomer(ls[0])
      const addr = (cust.address ?? null) as { logradouro?: string | null; cidade?: string | null; uf?: string | null; cep?: string | null } | null
      const temEndereco = !!(addr?.logradouro && addr.cidade && addr.uf && String(addr.cep ?? '').replace(/\D/g, '').length === 8)
      const doc = String(cust.doc ?? '').replace(/\D/g, '')
      const temDoc = doc.length === 11 || doc.length === 14
      const semNcm = ls.filter((l) => !l.product_id || !fiscalMap.get(l.product_id)?.ncm).map((l) => l.sku)
      const pago = Number((ls[0].raw_data as { total_amount?: unknown } | null)?.total_amount)
      const somaItens = ls.reduce((s, l) => s + (Number(l.sale_price) || 0), 0)
      const valor = round2(Number.isFinite(pago) && pago > 0 ? pago : somaItens)

      const foId = foBySn.get(orderSn)
      const inv = foId ? invByFo.get(foId) : undefined
      // janela de cancelamento: 24h da autorização (regra da maioria das UFs)
      const horasRestantes = inv
        ? Math.max(0, Math.round((new Date(inv.created_at).getTime() + 24 * 3600_000 - Date.now()) / 360_000) / 10)
        : null
      const nota = inv ? {
        id: inv.id, number: inv.number, chave: inv.access_key,
        noMarketplace: !!inv.marketplace_sent_at,
        podeCancelar: (horasRestantes ?? 0) > 0, horasPraCancelar: horasRestantes,
      } : null

      const falta: string[] = []
      if (!temDoc) falta.push('CPF/CNPJ do comprador')
      if (!temEndereco) falta.push('endereço do comprador')
      if (semNcm.length) falta.push(`NCM de ${semNcm.join(', ')}`)
      pedidos.push({
        orderSn, comprador: (cust.name as string | null) ?? null, valor,
        loja: ls[0].channel_account_id, temEndereco, temDoc, semNcm, nota,
        pronto: !nota && falta.length === 0, falta,
      })
    }
    const resumo = {
      total: pedidos.length,
      prontos: pedidos.filter((p) => p.pronto).length,
      jaEmitidos: pedidos.filter((p) => p.nota).length,
      bloqueados: pedidos.filter((p) => !p.nota && p.falta.length > 0).length,
    }
    return { pedidos, resumo }
  }

  /** CONTROLE DE NOTAS — histórico completo, filtrável. Diferente da fila
   *  (que é só a janela de hoje), aqui está tudo que já virou nota, por
   *  plataforma/conta/período, com o caminho dos arquivos pra download. */
  async listarNotas(orgId: string, f: {
    plataforma?: string; conta?: string; status?: 'issued' | 'cancelled'
    de?: string; ate?: string; busca?: string; limite?: number; offset?: number
  } = {}): Promise<{
    notas: Array<{
      id: string; numero: string | null; serie: string | null; chave: string | null
      status: string; emitidaEm: string; valor: number
      pedido: string | null; comprador: string | null
      plataforma: string | null; conta: string | null; contaLabel: string | null
      noMarketplace: boolean; cancelavelAte: string | null
      temXml: boolean; temPdf: boolean
    }>
    resumo: { quantidade: number; valorTotal: number; canceladas: number; pendentesMarketplace: number }
    total: number
  }> {
    const limite = Math.min(Math.max(Number(f.limite) || 100, 1), 500)
    const offset = Math.max(Number(f.offset) || 0, 0)

    let q = supabaseAdmin
      .from('fulfillment_invoices')
      .select('id, number, series, access_key, status, created_at, items, fulfillment_order_id, marketplace_sent_at, xml_url, proc_xml_url', { count: 'exact' })
      .eq('organization_id', orgId).eq('kind', 'venda')
      .in('status', ['issued', 'cancelled'])
    if (f.status) q = q.eq('status', f.status)
    if (f.de) q = q.gte('created_at', f.de)
    if (f.ate) q = q.lte('created_at', f.ate)
    const { data, count } = await q.order('created_at', { ascending: false }).range(offset, offset + limite - 1)
    const rows = (data ?? []) as Array<{
      id: string; number: string | null; series: string | null; access_key: string | null; status: string
      created_at: string; items: Array<{ qty: number; unit_value: number | null }>; fulfillment_order_id: string
      marketplace_sent_at: string | null; xml_url: string | null; proc_xml_url: string | null
    }>
    if (rows.length === 0) return { notas: [], resumo: { quantidade: 0, valorTotal: 0, canceladas: 0, pendentesMarketplace: 0 }, total: count ?? 0 }

    // pedido de origem → plataforma/conta/comprador
    const { data: fos } = await supabaseAdmin
      .from('fulfillment_orders').select('id, source_id, channel')
      .eq('organization_id', orgId).in('id', rows.map((r) => r.fulfillment_order_id))
    const foById = new Map((fos ?? []).map((o) => [(o as { id: string }).id, o as { source_id: string | null; channel: string | null }]))
    const sns = [...new Set([...foById.values()].map((o) => o.source_id).filter((v): v is string => !!v))]
    const { data: ords } = sns.length
      ? await supabaseAdmin.from('orders').select('external_order_id, buyer_name, platform, channel_account_id')
        .eq('organization_id', orgId).in('external_order_id', sns)
      : { data: [] }
    const ordBySn = new Map((ords ?? []).map((o) => [(o as { external_order_id: string }).external_order_id, o as { buyer_name: string | null; platform: string | null; channel_account_id: string | null }]))
    const { data: accs } = await supabaseAdmin
      .from('fulfillment_accounts').select('external_account_id, label, platform').eq('organization_id', orgId)
    const labelByConta = new Map((accs ?? []).map((a) => [`${(a as { platform: string }).platform}:${(a as { external_account_id: string }).external_account_id}`, (a as { label: string | null }).label]))

    let notas = rows.map((r) => {
      const fo = foById.get(r.fulfillment_order_id)
      const sn = fo?.source_id ?? null
      const ord = sn ? ordBySn.get(sn) : undefined
      const plataforma = ord?.platform ?? fo?.channel ?? null
      const conta = ord?.channel_account_id ?? null
      const valor = round2((r.items ?? []).reduce((s, i) => s + (Number(i.unit_value) || 0) * (Number(i.qty) || 0), 0))
      const limite24h = new Date(new Date(r.created_at).getTime() + 24 * 3600_000)
      return {
        id: r.id, numero: r.number, serie: r.series, chave: r.access_key,
        status: r.status, emitidaEm: r.created_at, valor,
        pedido: sn, comprador: ord?.buyer_name ?? null,
        plataforma, conta, contaLabel: plataforma && conta ? (labelByConta.get(`${plataforma}:${conta}`) ?? null) : null,
        noMarketplace: !!r.marketplace_sent_at,
        cancelavelAte: r.status === 'issued' && limite24h.getTime() > Date.now() ? limite24h.toISOString() : null,
        temXml: !!(r.proc_xml_url || r.xml_url || r.access_key),
        temPdf: !!r.access_key,   // gerado sob demanda a partir do XML
      }
    })

    // filtros que dependem do join (plataforma/conta/busca) — aplicados aqui
    if (f.plataforma) notas = notas.filter((n) => n.plataforma === f.plataforma)
    if (f.conta) notas = notas.filter((n) => n.conta === f.conta)
    if (f.busca) {
      const t = f.busca.trim().toLowerCase()
      notas = notas.filter((n) =>
        (n.pedido ?? '').toLowerCase().includes(t) ||
        (n.comprador ?? '').toLowerCase().includes(t) ||
        (n.chave ?? '').includes(t.replace(/\D/g, '')) ||
        (n.numero ?? '').includes(t))
    }

    const resumo = {
      quantidade: notas.length,
      valorTotal: round2(notas.filter((n) => n.status === 'issued').reduce((s, n) => s + n.valor, 0)),
      canceladas: notas.filter((n) => n.status === 'cancelled').length,
      pendentesMarketplace: notas.filter((n) => n.status === 'issued' && !n.noMarketplace).length,
    }
    return { notas, resumo, total: count ?? notas.length }
  }

  /** Contas (plataforma × loja) que já emitiram nota — alimenta os filtros. */
  async contasComNota(orgId: string): Promise<Array<{ plataforma: string; conta: string; label: string | null }>> {
    const { data } = await supabaseAdmin
      .from('fulfillment_accounts').select('platform, external_account_id, label')
      .eq('organization_id', orgId).eq('is_active', true)
    return (data ?? []).map((a) => ({
      plataforma: (a as { platform: string }).platform,
      conta: (a as { external_account_id: string }).external_account_id,
      label: (a as { label: string | null }).label,
    }))
  }

  /** Link temporário pro arquivo da nota (xml = procNFe de distribuição). */
  async arquivoDaNota(orgId: string, invoiceId: string, tipo: 'xml'): Promise<{ url: string; filename: string }> {
    const { data } = await supabaseAdmin
      .from('fulfillment_invoices').select('access_key, proc_xml_url, xml_url')
      .eq('organization_id', orgId).eq('id', invoiceId).maybeSingle()
    const inv = data as { access_key: string | null; proc_xml_url: string | null; xml_url: string | null } | null
    if (!inv?.access_key) throw new NotFoundException('Nota não encontrada.')
    if (tipo !== 'xml') throw new BadRequestException('Tipo de arquivo não suportado.')

    // procNFe primeiro: é o que marketplace e contador aceitam
    const candidatos = [inv.proc_xml_url, `${orgId}/invoices/${inv.access_key}-procNFe.xml`, inv.xml_url, `${orgId}/invoices/${inv.access_key}-nfe.xml`]
    for (const p of candidatos.filter((v): v is string => !!v)) {
      const { data: signed } = await supabaseAdmin.storage.from(FULFILLMENT_BUCKET).createSignedUrl(p, 600)
      if (signed?.signedUrl) return { url: signed.signedUrl, filename: `NFe-${inv.access_key}.xml` }
    }
    throw new NotFoundException('Arquivo XML desta nota não está no armazenamento.')
  }

  /** Emite o LOTE de pedidos prontos. Sequencial de propósito: cada nota
   *  consome um número da série e bate na SEFAZ — paralelizar aqui só
   *  atrapalha. Um erro não derruba os demais. */
  async emitirLote(orgId: string, orderSns?: string[]): Promise<{
    emitidas: number; falhas: Array<{ pedido: string; erro: string }>
    notas: Array<{ pedido: string; numero: number | null; chave: string | null; noMarketplace: boolean }>
  }> {
    let alvos = orderSns?.filter(Boolean)
    if (!alvos?.length) {
      const fila = await this.filaFiscal(orgId)
      alvos = fila.pedidos.filter((p) => p.pronto).map((p) => p.orderSn)
    }
    const notas: Array<{ pedido: string; numero: number | null; chave: string | null; noMarketplace: boolean }> = []
    const falhas: Array<{ pedido: string; erro: string }> = []
    for (const sn of alvos) {
      try {
        const r = await this.emitForOrder(orgId, sn)
        if (r.authorized) notas.push({ pedido: sn, numero: r.nNF, chave: r.chave, noMarketplace: !!r.marketplace?.ok })
        else falhas.push({ pedido: sn, erro: `cStat ${r.cStat}: ${r.xMotivo}` })
      } catch (e) {
        falhas.push({ pedido: sn, erro: (e as Error).message })
      }
    }
    this.logger.log(`[emit-lote] org=${orgId} ${notas.length} emitidas, ${falhas.length} falhas`)
    return { emitidas: notas.length, falhas, notas }
  }

  /** Manda a NF-e autorizada pro marketplace. Hoje só Shopee (é quem exige a
   *  nota antes do despacho). Grava o resultado na invoice pra UI/reenvio. */
  private async enviarNotaProMarketplace(orgId: string, i: {
    invoiceId?: string; platform: string; shopId: string | null; orderSn: string
    number: string; serie: string; chave: string; total: number
  }): Promise<{ ok: boolean; erro?: string }> {
    const marcar = async (patch: Record<string, unknown>) => {
      if (i.invoiceId) await supabaseAdmin.from('fulfillment_invoices').update(patch).eq('id', i.invoiceId).eq('organization_id', orgId)
    }
    try {
      if (i.platform !== 'shopee') return { ok: false, erro: `envio automático ainda não suportado em ${i.platform || 'plataforma desconhecida'}` }
      if (!i.shopId) return { ok: false, erro: 'pedido sem loja identificada' }
      const conn0 = await this.mp.getConnectionByShop(orgId, Number(i.shopId))
      if (!conn0) return { ok: false, erro: `loja ${i.shopId} não está conectada` }
      const conn = await this.shopeeSync.ensureFreshToken(conn0)
      const adapter = this.registry.get('shopee') as ShopeeAdapter
      const r = await adapter.uploadInvoiceData(conn, i.orderSn, {
        number: i.number, seriesNumber: i.serie, accessKey: i.chave,
        issueDate: Math.floor(Date.now() / 1000),
        totalValue: i.total, productsTotalValue: i.total,
      })
      if (!r.ok) {
        const erro = `${r.error ?? 'erro'}: ${r.message ?? ''}`.trim()
        await marcar({ marketplace_error: erro })
        this.logger.warn(`[nf->marketplace] ${i.orderSn} recusada: ${erro}`)
        return { ok: false, erro }
      }
      await marcar({ marketplace_sent_at: new Date().toISOString(), marketplace_error: null })
      this.logger.log(`[nf->marketplace] ${i.orderSn} NF ${i.number} aceita pela Shopee`)
      return { ok: true }
    } catch (e) {
      const erro = (e as Error).message || 'falha desconhecida'
      await marcar({ marketplace_error: erro })
      this.logger.warn(`[nf->marketplace] ${i.orderSn}: ${erro}`)
      return { ok: false, erro }
    }
  }

  /** Reenvio manual/em lote das notas que ainda não foram aceitas pelo
   *  marketplace (falha de rede, token vencido, recusa temporária). */
  async reenviarNotasPendentes(orgId: string): Promise<{ tentadas: number; enviadas: number; falhas: Array<{ pedido: string; erro: string }> }> {
    const { data } = await supabaseAdmin
      .from('fulfillment_invoices')
      .select('id, number, series, access_key, items, fulfillment_order_id')
      .eq('organization_id', orgId).eq('status', 'issued').is('marketplace_sent_at', null).limit(200)
    const pendentes = (data ?? []) as Array<{ id: string; number: string | null; series: string | null; access_key: string | null; items: Array<{ qty: number; unit_value: number | null }>; fulfillment_order_id: string }>
    const falhas: Array<{ pedido: string; erro: string }> = []
    let enviadas = 0
    for (const p of pendentes) {
      const { data: fo } = await supabaseAdmin
        .from('fulfillment_orders').select('source_id, channel').eq('id', p.fulfillment_order_id).maybeSingle()
      const orderSn = (fo as { source_id: string | null } | null)?.source_id
      const platform = (fo as { channel: string | null } | null)?.channel ?? 'shopee'
      if (!orderSn || !p.access_key) continue
      const { data: ord } = await supabaseAdmin
        .from('orders').select('channel_account_id').eq('organization_id', orgId).eq('external_order_id', orderSn).limit(1).maybeSingle()
      const total = round2((p.items ?? []).reduce((s, it) => s + (Number(it.unit_value) || 0) * (Number(it.qty) || 0), 0))
      const r = await this.enviarNotaProMarketplace(orgId, {
        invoiceId: p.id, platform, shopId: (ord as { channel_account_id: string | null } | null)?.channel_account_id ?? null,
        orderSn, number: String(p.number ?? ''), serie: String(p.series ?? '1'), chave: p.access_key, total,
      })
      if (r.ok) enviadas++
      else falhas.push({ pedido: orderSn, erro: r.erro ?? '?' })
    }
    this.logger.log(`[nf->marketplace] reenvio org=${orgId}: ${enviadas}/${pendentes.length} aceitas`)
    return { tentadas: pendentes.length, enviadas, falhas }
  }

  // ── helpers do emitForOrder ──────────────────────────────────────────────
  private async orderRows(orgId: string, externalOrderId: string) {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('id, sku, product_id, product_title, quantity, sale_price, status, platform, seller_id, channel_account_id, buyer_name, buyer_doc_number, buyer_phone, raw_data')
      .eq('organization_id', orgId).eq('external_order_id', externalOrderId)
    return (data ?? []) as Array<{
      id: string; sku: string; product_id: string | null; product_title: string | null
      quantity: number; sale_price: number | null; status: string; platform: string | null
      seller_id: number | null; channel_account_id: string | null
      buyer_name: string | null; buyer_doc_number: string | null; buyer_phone: string | null
      raw_data: Record<string, unknown> | null
    }>
  }

  /** Garante o fulfillment_order do pedido (a invoice pendura nele). Em dryRun
   *  NÃO cria — só devolve se já existir. */
  private async ensureFulfillmentOrder(orgId: string, externalOrderId: string, dryRun: boolean): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('fulfillment_orders').select('id')
      .eq('organization_id', orgId).eq('source_type', 'marketplace').eq('source_id', externalOrderId)
      .limit(1).maybeSingle()
    if (data) return (data as { id: string }).id
    if (dryRun) return null
    try {
      const r = await this.fulfillment.seed(orgId, { source: 'marketplace', externalOrderId })
      return r.fulfillmentOrderId
    } catch (e) {
      this.logger.warn(`[emit-order] seed do fulfillment_order falhou: ${(e as Error).message}`)
      return null
    }
  }

  /** Código IBGE do município + BAIRRO do DESTINATÁRIO via ViaCEP (a Shopee não
   *  manda nenhum dos dois). Emissão é pontual — a latência é aceitável. */
  private async resolveIbgeByCep(cep: string): Promise<{ ibge: string; bairro: string | null }> {
    try {
      const { data } = await axios.get<{ ibge?: string; bairro?: string; erro?: boolean }>(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 8000 })
      const ibge = String(data?.ibge ?? '').replace(/\D/g, '')
      if (data?.erro || ibge.length !== 7) throw new Error('CEP sem código IBGE')
      const bairro = String(data?.bairro ?? '').trim() || null
      return { ibge, bairro }
    } catch {
      throw new BadRequestException(`Não consegui resolver o município do CEP ${cep} (ViaCEP) — confira o CEP do comprador.`)
    }
  }
}

/** Lê o retorno do envio síncrono. O 1º <cStat> do XML é o do LOTE (104 =
 *  "Lote processado" — diz nada sobre a nota); o veredito da NF-e vive DENTRO
 *  do <protNFe> (100 = autorizada, 2xx/7xx = rejeição). Ler o de fora fez uma
 *  nota AUTORIZADA aparecer como "⚠ 104" na tela (visto ao vivo 24/08). */
function parseRetornoSefaz(ret: string): { cStat: string | null; xMotivo: string | null; chave: string | null; protocolo: string | null } {
  const prot = /<protNFe[\s\S]*?<\/protNFe>/.exec(ret)?.[0]
  const scope = prot ?? ret
  return {
    cStat: /<cStat>(\d+)<\/cStat>/.exec(scope)?.[1] ?? null,
    xMotivo: /<xMotivo>([^<]+)<\/xMotivo>/.exec(scope)?.[1] ?? null,
    chave: /<chNFe>(\d{44})<\/chNFe>/.exec(ret)?.[1] ?? null,
    protocolo: /<nProt>(\d+)<\/nProt>/.exec(ret)?.[1] ?? null,
  }
}

/** Monta o XML de DISTRIBUIÇÃO (nfeProc) = nota assinada + protocolo de
 *  autorização no MESMO arquivo. É o que marketplace, contador e o comprador
 *  aceitam; o `<NFe>` sozinho é recusado ("Invalid NF-e" na Shopee, 24/08).
 *  Devolve null se o retorno não trouxer protNFe autorizado. */
export function montarNfeProc(nfeAssinada: string, retornoSefaz: string): string | null {
  const prot = /<protNFe[\s\S]*?<\/protNFe>/.exec(retornoSefaz)?.[0]
  if (!prot) return null
  if (!/<cStat>100<\/cStat>/.test(prot)) return null      // só autorizada vira nfeProc
  const nfe = nfeAssinada.replace(/^﻿/, '').replace(/^<\?xml[^>]*\?>/, '').trim()
  if (!/^<NFe[\s>]/.test(nfe)) return null
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
    + nfe + prot + '</nfeProc>'
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
function round4(n: number): number { return Math.round(n * 10000) / 10000 }
/** Agora em horário de Brasília no formato da NF-e (UTC-3 SEM horário de verão).
 *  ⚠️ `toISOString()` puro etiquetado de -03:00 marcaria a nota 3h NO FUTURO. */
function brtNow(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '-03:00')
}

// ── Intermediador (marketplace) — NT 2020.006 ────────────────────────────────
// Venda intermediada por marketplace SEM o grupo infIntermed é rejeitada (ou
// fica irregular). CNPJ por plataforma; idCadIntTran = identificação do
// vendedor NO SITE do intermediador (username/id da loja).
/** Override manual do destinatário — usado quando a plataforma mascara os dados
 *  (Shopee: endereço só abre depois de organizar o envio, que por sua vez exige
 *  a NF). Cada campo preenchido vence o capturado; os vazios caem no capturado. */
export interface DestOverride {
  name?: string | null; doc?: string | null
  logradouro?: string | null; numero?: string | null; complemento?: string | null
  bairro?: string | null; cidade?: string | null; uf?: string | null; cep?: string | null
}

export const INTERMEDIADORES: Record<string, { cnpj: string; nome: string }> = {
  // SHPS Tecnologia e Serviços Ltda (Shopee Brasil)
  shopee: { cnpj: '35635824000112', nome: 'Shopee' },
}

/** UFs que EXIGEM o grupo autXML identificando o escritório de contabilidade
 *  (rejeição 486). Emitente sem contador cadastrado informa o CNPJ da própria
 *  SEFAZ — texto literal da rejeição da BA (validação desde 01/01/2016). */
const AUTXML_POR_UF: Record<string, string> = {
  BA: '13937073000156',   // CNPJ da SEFAZ Bahia
}

/** Injeta o grupo <infIntermed> no XML da NF-e (o indIntermed=1 já vai no <ide>
 *  via tagIde). A node-sped-nfe 1.2.x NÃO implementa tagIntermed (lança "Não
 *  implementado!"), então inserimos direto na string ANTES de assinar: infIntermed
 *  logo após </pag> (ordem do leiaute 4.00). Lança se a âncora não existir —
 *  XML inválido NÃO pode seguir calado pra assinatura. */
export function injectIntermed(xml: string, intermed: { cnpj: string; idCadIntTran: string }): string {
  const cnpj = intermed.cnpj.replace(/\D/g, '')
  if (cnpj.length !== 14) throw new Error(`CNPJ do intermediador inválido: "${intermed.cnpj}"`)
  const idCad = intermed.idCadIntTran.trim().slice(0, 60)
  if (!idCad) throw new Error('idCadIntTran (identificação do vendedor no marketplace) vazio.')
  if (!xml.includes('</pag>')) throw new Error('XML sem <pag> — não dá pra ancorar infIntermed.')
  const esc = idCad.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return xml.replace('</pag>', `</pag><infIntermed><CNPJ>${cnpj}</CNPJ><idCadIntTran>${esc}</idCadIntTran></infIntermed>`)
}
