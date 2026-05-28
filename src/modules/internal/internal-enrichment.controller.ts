import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common'
import { InternalKeyGuard } from './internal-key.guard'
import { EnrichmentService } from '../enrichment/enrichment.service'

interface CpfEnrichBody {
  org_id: string
  cpf: string
  trigger_source?: 'manual' | 'auto' | 'batch'
  force_refresh?:  boolean
}

interface CnpjEnrichBody {
  org_id: string
  cnpj: string
  trigger_source?: 'manual' | 'auto' | 'batch'
  force_refresh?:  boolean
}

/**
 * Bridge interna pra que outros sistemas (eclick-active / Prospect) chamem
 * o motor de enrichment do SaaS sem precisar de JWT do user.
 *
 * Auth: X-Internal-Key (mesmo padrão do resto do `internal` module).
 *
 * Casos de uso atuais:
 *  • e-Click Active / Prospect: `collectPf()` chama `/internal/enrichment/cpf`
 *    quando uma entity PF entra na fila de enriquecimento.
 *  • CNPJ disponível também (atalho server-to-server) caso Active queira
 *    enriquecer CNPJ camada 1 sem montar collector próprio.
 *
 * O routing por org + cache + cost tracking ficam todos no EnrichmentService —
 * essa controller é só o entrypoint sem auth de user.
 */
@Controller('internal/enrichment')
@UseGuards(InternalKeyGuard)
export class InternalEnrichmentController {
  private readonly logger = new Logger(InternalEnrichmentController.name)

  constructor(private readonly enrichment: EnrichmentService) {}

  @Post('cpf')
  @HttpCode(HttpStatus.OK)
  async enrichCpf(@Body() body: CpfEnrichBody) {
    const orgId = body?.org_id?.trim()
    const cpf   = (body?.cpf ?? '').replace(/\D+/g, '')
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    if (cpf.length !== 11) throw new BadRequestException('cpf deve ter 11 dígitos')
    this.logger.log(`[internal-enrichment.cpf] org=${orgId} cpf=***${cpf.slice(-2)}`)
    return this.enrichment.enrich({
      organization_id: orgId,
      query_type:      'cpf',
      query_value:     cpf,
      trigger_source:  body.trigger_source ?? 'manual',
      force_refresh:   body.force_refresh ?? false,
    })
  }

  @Post('cnpj')
  @HttpCode(HttpStatus.OK)
  async enrichCnpj(@Body() body: CnpjEnrichBody) {
    const orgId = body?.org_id?.trim()
    const cnpj  = (body?.cnpj ?? '').replace(/\D+/g, '')
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    if (cnpj.length !== 14) throw new BadRequestException('cnpj deve ter 14 dígitos')
    this.logger.log(`[internal-enrichment.cnpj] org=${orgId} cnpj=${cnpj}`)
    return this.enrichment.enrich({
      organization_id: orgId,
      query_type:      'cnpj',
      query_value:     cnpj,
      trigger_source:  body.trigger_source ?? 'manual',
      force_refresh:   body.force_refresh ?? false,
    })
  }
}
