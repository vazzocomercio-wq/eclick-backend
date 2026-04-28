import { Injectable, Logger } from '@nestjs/common'

/** Stub do envio por email pra CC-2. Apenas loga. Implementação real
 * (SendGrid/Resend) entra em CC-3. Mantém o shape do retorno do
 * WhatsAppSender pra simetria no JourneyEngineService.executeSend. */
@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name)

  async sendEmail(input: {
    to:      string
    subject: string
    body:    string
  }): Promise<{ success: boolean; error?: string }> {
    if (!input.to) return { success: false, error: 'destinatário vazio' }
    this.logger.log(
      `[email.sender] TO: ${input.to} SUBJECT: ${input.subject} (stub — CC-3 implementa envio real)`,
    )
    return { success: true }
  }
}
