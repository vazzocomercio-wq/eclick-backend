import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { Tools } from 'node-sped-nfe'
import { supabaseAdmin } from '../../common/supabase'
import { FulfillmentFiscalService } from './fulfillment-fiscal.service'

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

  constructor(private readonly fiscal: FulfillmentFiscalService) {}

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

  /** Emite uma NF-e de TESTE (sempre homologação) — Simples Nacional, 1 produto
   *  genérico, destinatário de teste. Serve pra validar a emissão ponta a ponta.
   *  Itera ao vivo contra as rejeições da SEFAZ até cStat 100 (autorizada). */
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
      const nNF = Number(String(Date.now()).slice(-8))         // número único pro teste (evita duplicidade)
      const dhEmi = new Date().toISOString().replace(/\.\d{3}Z$/, '-03:00')
      const ender = { xLgr: addr.logradouro, nro: addr.numero, xBairro: addr.bairro, cMun, xMun: addr.city, UF: uf, CEP: addr.cep.replace(/\D/g, ''), cPais: '1058', xPais: 'BRASIL' }

      make.tagInfNFe({ versao: '4.00' })
      make.tagIde({ cUF, cNF, natOp: 'VENDA DE MERCADORIA', mod: 55, serie: 1, nNF, dhEmi, tpNF: 1, idDest: 1, cMunFG: cMun, tpImp: 1, tpEmis: 1, tpAmb: 2, finNFe: 1, indFinal: 1, indPres: 1, procEmi: 0, verProc: 'eClick-1.0' })
      make.tagEmit({ CNPJ: cnpj, xNome: c?.name || 'EMITENTE TESTE', xFant: c?.name || 'EMITENTE', IE: (cfg!.inscricao_estadual ?? '').replace(/\D/g, ''), CRT: 1 })
      make.tagEnderEmit(ender)
      make.tagDest({ CPF: '11144477735', xNome: 'CONSUMIDOR TESTE', indIEDest: 9 })   // homolog sobrescreve o xNome
      make.tagEnderDest(ender)
      await make.tagProd([{ cProd: 'TESTE001', cEAN: 'SEM GTIN', xProd: 'PRODUTO TESTE', NCM: '49011000', CFOP: '5102', uCom: 'UN', qCom: 1, vUnCom: 1.00, vProd: 1.00, cEANTrib: 'SEM GTIN', uTrib: 'UN', qTrib: 1, vUnTrib: 1.00, indTot: 1 }])
      make.tagProdICMSSN(0, { orig: '0', CSOSN: '102' })
      make.tagProdPIS(0, { CST: '49', vBC: '0.00', pPIS: '0.0000', vPIS: '0.00' })
      make.tagProdCOFINS(0, { CST: '49', vBC: '0.00', pCOFINS: '0.0000', vCOFINS: '0.00' })
      make.tagTotal({})          // {} = deixa a lib calcular os totais automaticamente
      make.tagTransp({ modFrete: '9' })
      make.tagDetPag([{ indPag: '0', tPag: '90', vPag: '0.00' }])
      make.tagInfRespTec({ CNPJ: cnpj, xContato: c?.name || 'Vazzo', email: 'vazzocomercio@gmail.com', fone: '1140000000' })

      const xml = make.xml()
      const signed = await tools.xmlSign(xml)
      // a lib tipa indSinc como literal 0; síncrono (1) é o que queremos pro teste
      const ret = await tools.sefazEnviaLote(signed, { idLote: 1, indSinc: 1, compactar: false } as unknown as { idLote?: 1; indSinc?: 0; compactar?: false })
      const cStat = /<cStat>(\d+)<\/cStat>/g.exec(ret)?.[1] ?? null
      const xMotivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(ret)?.[1] ?? null
      const chave = /<chNFe>(\d{44})<\/chNFe>/.exec(ret)?.[1] ?? null
      const protocolo = /<nProt>(\d+)<\/nProt>/.exec(ret)?.[1] ?? null
      this.logger.log(`[emit-test] org=${orgId} company=${companyId} cStat=${cStat} ${xMotivo}`)
      return { authorized: cStat === '100', cStat, xMotivo, chave, protocolo }
    } catch (e) {
      const msg = (e as Error).message || JSON.stringify(e)
      this.logger.warn(`[emit-test] org=${orgId} company=${companyId}: ${msg}`)
      throw new BadRequestException(`Falha ao emitir NF-e de teste: ${msg}`)
    } finally {
      cleanup()
    }
  }
}
