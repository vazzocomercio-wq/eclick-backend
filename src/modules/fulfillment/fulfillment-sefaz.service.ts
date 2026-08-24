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
  async emitForOrder(orgId: string, externalOrderId: string, opts?: { dryRun?: boolean }): Promise<{
    authorized: boolean; dryRun?: boolean; cStat: string | null; xMotivo: string | null
    chave: string | null; protocolo: string | null; nNF: number | null; serie: number
    invoiceId?: string; xml?: string
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

    // ── 4. destinatário (capturado na janela aberta) ───────────────────────
    const cust = marketplaceCustomer(rows[0])
    const doc = String(cust.doc ?? '').replace(/\D/g, '')
    if (doc.length !== 11 && doc.length !== 14) {
      throw new BadRequestException('CPF/CNPJ do comprador ainda não capturado. Emita DURANTE a preparação do envio (janela em que a Shopee abre os dados) — acabei de tentar pela etiqueta e não veio.')
    }
    const dAddr = (cust.address ?? null) as { logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null; cep?: string | null } | null
    const dCep = String(dAddr?.cep ?? '').replace(/\D/g, '')
    if (!dAddr?.logradouro || !dAddr.cidade || !dAddr.uf || dCep.length !== 8) {
      throw new BadRequestException('Endereço do comprador incompleto (logradouro/cidade/UF/CEP). A janela da Shopee pode ter fechado — tente com o pedido em "A enviar".')
    }
    const dCMun = await this.resolveIbgeByCep(dCep)   // cMun do DESTINATÁRIO via ViaCEP

    // ── 5. itens: % da conta → kits explodidos → fiscal por produto ────────
    const pct = await this.fiscal.getEffectivePct(orgId, acc.id)
    const fator = (Number(pct.salePct) || 100) / 100
    const lines = rows.map((r) => ({
      product_id: r.product_id, sku: r.sku, description: r.product_title,
      qty: Number(r.quantity) || 1,
      unit_value: round4(((Number(r.sale_price) || 0) * fator) / (Number(r.quantity) || 1)),
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
      xBairro: String(dAddr.bairro ?? 'CENTRO').slice(0, 60), cMun: dCMun,
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
    const destNome = tpAmb === 2 ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : String(cust.name ?? 'CONSUMIDOR').slice(0, 60)
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
      if (cStat === '100' && chave) {
        // guarda o XML assinado + protocolo (obrigação de 5 anos) e registra a invoice
        const base = `${orgId}/invoices/${chave}`
        await supabaseAdmin.storage.from(FULFILLMENT_BUCKET).upload(`${base}-nfe.xml`, Buffer.from(signed, 'utf8'), { contentType: 'application/xml', upsert: true })
        await supabaseAdmin.storage.from(FULFILLMENT_BUCKET).upload(`${base}-prot.xml`, Buffer.from(ret, 'utf8'), { contentType: 'application/xml', upsert: true })
        const foId = fo ?? await this.ensureFulfillmentOrder(orgId, externalOrderId, false)
        if (foId) {
          const r = await this.invoices.upsertForOrder(orgId, foId, {
            companyId, kind: 'venda', status: 'issued',
            number: String(nNF), series: String(serie), accessKey: chave,
            xmlUrl: `${base}-nfe.xml`, provider: 'sefaz_direto',
            items: exploded.map((l) => ({ sku: String(l.sku ?? ''), description: l.description ?? null, qty: Number(l.qty) || 0, unit_value: l.unit_value ?? null })),
          })
          invoiceId = r.id
        }
      }
      return { authorized: cStat === '100', cStat, xMotivo, chave, protocolo, nNF, serie, invoiceId }
    } catch (e) {
      const msg = (e as Error).message || JSON.stringify(e)
      this.logger.warn(`[emit-order] ${externalOrderId}: ${msg}`)
      throw new BadRequestException(`Falha ao emitir NF-e do pedido ${externalOrderId}: ${msg}`)
    } finally {
      cleanup()
    }
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

  /** Código IBGE do município do DESTINATÁRIO via ViaCEP (a Shopee não manda).
   *  Emissão é operação pontual — a latência da consulta é aceitável. */
  private async resolveIbgeByCep(cep: string): Promise<string> {
    try {
      const { data } = await axios.get<{ ibge?: string; erro?: boolean }>(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 8000 })
      const ibge = String(data?.ibge ?? '').replace(/\D/g, '')
      if (data?.erro || ibge.length !== 7) throw new Error('CEP sem código IBGE')
      return ibge
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
