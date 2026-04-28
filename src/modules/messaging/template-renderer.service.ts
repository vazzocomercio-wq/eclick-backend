import { Injectable, Logger } from '@nestjs/common'

/** Substitui {{var}} por context[var]. Variáveis ausentes/null viram ''
 * (CC-2: templates precisam de fail-soft pra não vazar {{var}} no WA).
 * Whitespace tolerado em {{ var }}. Vars conhecidas: first_name, full_name,
 * order_id, product_name, tracking_code, seller_nickname, store_name,
 * delivery_date, total_amount. */
@Injectable()
export class TemplateRendererService {
  private readonly logger = new Logger(TemplateRendererService.name)

  render(template: string, context: Record<string, unknown>): string {
    const missing: string[] = []
    const out = template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_match, key: string) => {
      const v = context?.[key]
      if (v === undefined || v === null || v === '') {
        missing.push(key)
        return ''
      }
      return String(v)
    })
    if (missing.length > 0) {
      this.logger.warn(`[template.render] missing vars=${[...new Set(missing)].join(',')}`)
    }
    return out
  }

  /** Lista variáveis referenciadas (uso: UI de preview, validação). */
  extractVariables(template: string): string[] {
    const out = new Set<string>()
    const re = /\{\{\s*([\w]+)\s*\}\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(template))) out.add(m[1])
    return [...out]
  }
}
