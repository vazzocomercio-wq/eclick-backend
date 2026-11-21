import type { AlertSignal, AlertSeverity } from '../analyzers/analyzers.types'

/**
 * Formata um signal pra mensagem de WhatsApp do gestor.
 *
 * Padrão:
 *   🚨 *RUPTURA IMINENTE*
 *
 *   📦 *Tênis Run Pro Black 42*
 *   Estoque acaba em 3.5 dias (12u, vende 3.4/dia).
 *
 *   💡 Comprar urgente ~90u pra cobrir 30 dias.
 *
 *   _Responda:_
 *   *1* — Aprovar
 *   *2* — Ver detalhes
 *   *3* — Ignorar
 *
 * O formato com asteriscos é o markdown nativo do WhatsApp.
 */

/** Categorias só informativas: nada a responder, então sem o rodapé 1/2/3.
 *  ia_fora_do_ar pede ação, mas no console do provedor, não por resposta. */
const SEM_RESPOSTA = new Set(['aviso_operador', 'ia_fora_do_ar', 'ia_normalizada'])

const SEVERITY_PREFIX: Record<AlertSeverity, string> = {
  critical: '🚨',
  warning:  '⚠️',
  info:     '📊',
}

const ENTITY_PREFIX: Record<string, string> = {
  product:  '📦',
  order:    '🧾',
  campaign: '📣',
  supplier: '🏭',
  category: '🏷️',
}

export function formatSignalMessage(signal: AlertSignal, managerName?: string): string {
  const severityIcon = SEVERITY_PREFIX[signal.severity] ?? '📊'
  const categoryLabel = humanizeCategory(signal.category)

  const lines: string[] = []
  // Aviso de operador (Ads semanal etc.): o título do aviso É o cabeçalho.
  const avisoOperador = signal.category === 'aviso_operador' && !!signal.entity_name
  lines.push(`${severityIcon} *${avisoOperador ? signal.entity_name : categoryLabel}*`)
  lines.push('')

  if (signal.entity_name && !avisoOperador) {
    const entityIcon = (signal.entity_type && ENTITY_PREFIX[signal.entity_type]) ?? '•'
    lines.push(`${entityIcon} *${signal.entity_name}*`)
  }

  lines.push(signal.summary_pt)

  if (signal.suggestion_pt) {
    lines.push('')
    lines.push(`💡 ${signal.suggestion_pt}`)
  }

  // Rodapé de resposta só quando há ação a responder (regra do dono 21/11/2026).
  // data.resposta: 'nenhuma' = sem rodapé · texto = rodapé próprio · ausente = padrão
  // (exceto categorias só informativas, que saem sem rodapé).
  const resposta = (signal.data as { resposta?: unknown } | null)?.resposta
  if (typeof resposta === 'string' && resposta !== 'nenhuma') {
    lines.push('')
    lines.push(resposta)
  } else if (resposta === undefined && !SEM_RESPOSTA.has(signal.category)) {
    lines.push('')
    lines.push('_Responda:_')
    lines.push('*1* — Aprovar')
    lines.push('*2* — Ver detalhes')
    lines.push('*3* — Ignorar')
  }

  // Header pessoal opcional na primeira interação do dia (TODO IH-4)
  void managerName

  return lines.join('\n')
}

/**
 * Converte snake_case → "Snake Case" amigável.
 * Mapeia categorias conhecidas pra labels mais expressivas.
 */
function humanizeCategory(cat: string): string {
  const known: Record<string, string> = {
    ruptura_iminente: 'RUPTURA IMINENTE',
    estoque_baixo:    'ESTOQUE BAIXO',
    estoque_alto:     'ESTOQUE PARADO',
    sem_movimento:    'SEM MOVIMENTO',
    ia_fora_do_ar:    'IA DO E-CLICK FORA DO AR',
    ia_normalizada:   'IA DO E-CLICK VOLTOU',
  }
  if (known[cat]) return known[cat]
  return cat.replace(/_/g, ' ').toUpperCase()
}
