import { Injectable, Logger, BadRequestException } from '@nestjs/common'
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

  private async toolsFor(orgId: string, companyId: string): Promise<Tools> {
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

    const { Tools } = await loadSpedNfe('node-sped-nfe')
    return new Tools(
      { mod: '55', xmllint: '', UF: uf, tpAmb, CSC: '', CSCid: '', versao: '4.00', timeout: 30000, openssl: null, CPF: '', CNPJ: cnpj },
      { pfx: cert.pfxBase64, senha: cert.password },
    )
  }

  /** Status do Serviço na SEFAZ da UF da empresa. cStat 107 = serviço em operação. */
  async statusServico(orgId: string, companyId: string): Promise<{ ok: boolean; cStat: string | null; xMotivo: string | null; uf: string; ambiente: string }> {
    const cfg = await this.fiscal.getCompanyFiscal(orgId, companyId)
    const uf = ((cfg?.fiscal_address as Record<string, string> | undefined)?.uf || 'SP').toUpperCase()
    const ambiente = cfg?.environment === 'producao' ? 'produção' : 'homologação'
    try {
      const tools = await this.toolsFor(orgId, companyId)
      const xml = await tools.sefazStatus()
      const cStat = /<cStat>(\d+)<\/cStat>/.exec(xml)?.[1] ?? null
      const xMotivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(xml)?.[1] ?? null
      return { ok: cStat === '107', cStat, xMotivo, uf, ambiente }
    } catch (e) {
      const msg = (e as Error).message || 'falha desconhecida'
      this.logger.warn(`[sefaz-status] org=${orgId} company=${companyId}: ${msg}`)
      throw new BadRequestException(`Não consegui falar com a SEFAZ-${uf} (${ambiente}): ${msg}`)
    }
  }
}
