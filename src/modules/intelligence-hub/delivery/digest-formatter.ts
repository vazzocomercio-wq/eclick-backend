import type { AlertSignal, AlertSeverity } from '../analyzers/analyzers.types'

const SEVERITY_HEADER: Record<AlertSeverity, { icon: string; label: string }> = {
  critical: { icon: '🚨', label: 'Críticos' },
  warning:  { icon: '⚠️', label: 'Atenção' },
  info:     { icon: '📊', label: 'Informativos' },
}

const DIGEST_TITLES: Record<string, string> = {
  digest_morning:   'Resumo da manhã',
  digest_afternoon: 'Resumo do meio-dia',
  digest_evening:   'Resumo do dia',
}

/**
 * Compila N signals num único corpo de mensagem WhatsApp.
 *
 * Agrupa por severity (critical primeiro), enumera lista. Não usa números
 * acionáveis (1/2/3) pra evitar conflito com mapping de resposta — se o
 * gestor quiser agir, abre o dashboard.
 */
export function formatDigestMessage(
  signals:    AlertSignal[],
  digestType: 'digest_morning' | 'digest_afternoon' | 'digest_evening',
  managerName?: string,
): string {
  const title = DIGEST_TITLES[digestType] ?? 'Resumo'
  const total = signals.length

  const lines: string[] = []
  lines.push(`📋 *${title}*${managerName ? ` — ${managerName}` : ''}`)
  lines.push(`_${total} alerta${total !== 1 ? 's' : ''}_`)

  const grouped: Record<AlertSeverity, AlertSignal[]> = {
    critical: [], warning: [], info: [],
  }
  for (const s of signals) grouped[s.severity].push(s)

  let index = 0
  for (const sev of ['critical', 'warning', 'info'] as AlertSeverity[]) {
    const arr = grouped[sev]
    if (arr.length === 0) continue

    const head = SEVERITY_HEADER[sev]
    lines.push('')
    lines.push(`${head.icon} *${head.label} (${arr.length})*`)

    for (const s of arr) {
      index++
      const name = s.entity_name ?? humanizeCategory(s.category)
      const sku  = (s.data?.sku as string | null | undefined) ?? null
      const header = sku ? `*${name}* _(${sku})_` : `*${name}*`
      lines.push(`${index}. ${header} — ${oneLineSummary(s, name)}`)
    }
  }

  lines.push('')
  lines.push('_Abra o dashboard pra agir nos alertas._')

  return lines.join('\n')
}

/** Remove duplicação do nome no início (analyzers historicamente prefixam
 *  com `${name} ...` no summary_pt). Aí pega primeira frase. */
function oneLineSummary(s: AlertSignal, entityName: string | null): string {
  let body = s.summary_pt.trim()

  // Remove prefixo do nome se presente (case-insensitive, robusto a "..." truncate)
  if (entityName) {
    const namePrefix = entityName.trim().toLowerCase()
    const bodyLower  = body.toLowerCase()
    if (bodyLower.startsWith(namePrefix)) {
      body = body.slice(entityName.length).trim()
      // Remove leading "com ", "tem ", "está ", connectores comuns
      body = body.replace(/^(com|tem|está|esta|teve|tinha|terá|sera|será)\s+/i, '')
      // Capitaliza primeira letra
      if (body.length > 0) {
        body = body[0].toUpperCase() + body.slice(1)
      }
    }
  }

  // Pega primeira frase
  const first = body.split(/(?<=[.!?])\s/)[0]
  return first.length <= 100 ? first : first.slice(0, 97) + '…'
}

function humanizeCategory(cat: string): string {
  return cat.replace(/_/g, ' ')
}
