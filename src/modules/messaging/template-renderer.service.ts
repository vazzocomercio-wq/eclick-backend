import { Injectable } from '@nestjs/common'

/** Substitui {{var}} por context[var]. Variáveis ausentes ficam como
 * estão (não quebra a mensagem). Whitespace tolerated em {{ var }}. */
@Injectable()
export class TemplateRendererService {
  render(template: string, context: Record<string, unknown>): string {
    return template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (match, key: string) => {
      const v = context?.[key]
      return v === undefined || v === null ? match : String(v)
    })
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
