// Prompt da sugestão pós-venda. Saída SEMPRE em texto puro PT-BR, ≤350 chars.
// O service valida charCount e regenera 1x com instrução reforçada se exceder.

export const POSTSALE_MAX_CHARS = 350
export const DEFAULT_POSTSALE_PERSONA = 'Cordial, objetiva e profissional. Trata o comprador como cliente importante sem ser bajulador.'

export interface SuggestPostsaleContext {
  persona?:             string
  productTitle?:        string
  shippingStatus?:      string
  estimatedDelivery?:   string
  orderTotal?:          number
  knowledge?:           string
  conversationHistory?: Array<{ direction: 'buyer' | 'seller'; text: string }>
  lastBuyerMessage:     string
}

export function buildSuggestPostsaleSystemPrompt(persona?: string, regenerateForced = false): string {
  const personaLine = persona?.trim() || DEFAULT_POSTSALE_PERSONA
  const hardCap = regenerateForced
    ? `1. Resposta DEVE ter NO MÁXIMO ${POSTSALE_MAX_CHARS} caracteres. Conte os caracteres antes de responder. SE PASSAR, ENCURTE ATÉ COUBER. Esta é a regra mais importante.`
    : `1. Resposta deve ter NO MÁXIMO ${POSTSALE_MAX_CHARS} caracteres (incluindo espaços e pontuação).`
  return `Você é assistente de atendimento pós-venda no Mercado Livre.

REGRAS DURAS (NUNCA violar):
${hardCap}
2. NUNCA peça telefone, WhatsApp, email, Instagram ou redes sociais.
3. NUNCA envie links externos.
4. NUNCA peça pro cliente abrir reclamação.
5. NUNCA peça pro cliente NÃO abrir reclamação.
6. NUNCA prometa prazo, desconto ou reembolso fora dos dados fornecidos.
7. NUNCA invente política, garantia ou prazo.
8. NUNCA admita defeito sem análise.
9. NUNCA discuta com o comprador.
10. Use SEMPRE linguagem cordial e objetiva.

Persona: ${personaLine}

Saída: texto puro em PT-BR. Sem markdown, sem emojis, sem títulos, sem aspas envolvendo a resposta. Comece direto com a mensagem ao cliente.`
}

export function buildSuggestPostsaleUserPrompt(ctx: SuggestPostsaleContext): string {
  const lines: string[] = ['Dados da venda:']
  lines.push(`- Produto: ${ctx.productTitle ?? '(não informado)'}`)
  lines.push(`- Status do envio: ${ctx.shippingStatus ?? '(não informado)'}`)
  lines.push(`- Prazo: ${ctx.estimatedDelivery ?? '(não informado)'}`)
  if (typeof ctx.orderTotal === 'number') {
    lines.push(`- Valor: R$ ${ctx.orderTotal.toFixed(2).replace('.', ',')}`)
  }

  lines.push('')
  lines.push('Conhecimento do produto:')
  lines.push(ctx.knowledge?.trim() || '(sem informações cadastradas — não invente políticas)')

  lines.push('')
  lines.push('Histórico recente da conversa:')
  if (ctx.conversationHistory && ctx.conversationHistory.length > 0) {
    for (const h of ctx.conversationHistory) {
      const who = h.direction === 'buyer' ? 'Comprador' : 'Vendedor'
      lines.push(`${who}: ${h.text}`)
    }
  } else {
    lines.push('(primeira interação)')
  }

  lines.push('')
  lines.push('Mensagem do comprador agora:')
  lines.push(ctx.lastBuyerMessage)
  lines.push('')
  lines.push(`Gere a resposta em PT-BR, ≤ ${POSTSALE_MAX_CHARS} caracteres, sem markdown, sem emojis, sem títulos.`)
  return lines.join('\n')
}
