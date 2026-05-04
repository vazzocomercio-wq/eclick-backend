import { Logger } from '@nestjs/common'
import type { AnalyzerName, SignalDraft } from './analyzers.types'

/**
 * Contrato base pra todos os analyzers do Intelligence Hub.
 *
 * Subclasses implementam scan(orgId) — a chamada pode ser disparada manualmente
 * (POST /analyzers/:name/run) ou agendada por cron via @nestjs/schedule.
 *
 * O analyzer NÃO grava em alert_signals — só retorna drafts. A persistência
 * fica com AlertSignalsService.insertMany(), que então enfileira no
 * AlertEngine pra rotear → deliveries.
 *
 * Isso mantém o analyzer puro/testável e desacopla I/O de regra de negócio.
 */
export abstract class BaseAnalyzer {
  protected readonly logger = new Logger(this.constructor.name)

  abstract readonly name: AnalyzerName

  /**
   * Executa a análise pra uma organização. Retorna 0..N drafts.
   * Pode lançar exceções; o orquestrador trata e loga.
   */
  abstract scan(orgId: string): Promise<SignalDraft[]>
}
