import { Injectable, Logger } from '@nestjs/common'
import { EmailSettingsService } from '../email-settings/email-settings.service'

/** Dispatcher multi-tenant pra envio de email (Sprint EM-1). Em vez de ler
 * RESEND_API_KEY do env (single-tenant), busca a config criptografada da
 * tabela email_settings via EmailSettingsService.getDecryptedKey(orgId) e
 * delega o HTTP call pro mesmo service.sendVia() — Resend ou SendGrid
 * dependendo do provider escolhido pela org no UI de Integrações.
 *
 * Chamado por JourneyEngineService.executeSend quando o canal escolhido em
 * CC-2 é 'email'. Se a org não tiver email configurado, retorna failed
 * sem trancar a journey (compat com fluxo atual). */
@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name)

  constructor(private readonly settings: EmailSettingsService) {}

  async sendEmail(input: {
    orgId:   string
    to:      string
    subject: string
    body:    string
  }): Promise<{ success: boolean; error?: string; messageId?: string }> {
    if (!input.orgId) return { success: false, error: 'orgId ausente' }
    if (!input.to)    return { success: false, error: 'destinatário vazio' }

    const cfg = await this.settings.getDecryptedKey(input.orgId)
    if (!cfg) return { success: false, error: 'Email não configurado pra essa org' }

    const r = await this.settings.sendVia(
      cfg.provider, cfg.apiKey,
      cfg.fromName, cfg.fromAddress,
      input.to, input.subject, input.body,
    )
    if (r.ok) {
      this.logger.log(`[email.sender] provider=${cfg.provider} TO: ${input.to} SUBJECT: ${input.subject} messageId: ${r.messageId ?? '(sem id)'}`)
      return { success: true, messageId: r.messageId }
    }
    this.logger.error(`[email.sender] FALHOU provider=${cfg.provider} TO: ${input.to}: ${r.error}`)
    return { success: false, error: r.error }
  }
}
