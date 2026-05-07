// Prompt da sugestão pra perguntas pré-venda do ML. Migrado do
// ml-questions-ai.service.ts com mesmo comportamento (3 linhas, sem markdown,
// sem header "Resposta:"). Mantido modular pra cobertura por testes.

export interface SuggestQuestionContext {
  agentSystemPrompt?: string
  productTitle?:      string
  productPrice?:      number | string
  productCondition?:  string
  availableQuantity?: number
  history?:           Array<{ question: string; answer: string }>
  questionText:       string
}

export function buildSuggestQuestionSystemPrompt(agentPrompt?: string): string {
  const personaLine = agentPrompt?.trim() || 'Seja objetivo e profissional.'
  return `Você é assistente de vendas do Mercado Livre.
${personaLine}
REGRAS:
- Responda só sobre o produto, máx 3 linhas, português brasileiro, sem mencionar concorrentes.
- NUNCA use markdown: nada de #, ##, ###, **negrito**, _itálico_, listas com - ou *.
- NUNCA inicie com título/header tipo "# Resposta ao Cliente", "## Resposta", "Resposta:" ou similar.
- Comece DIRETO com a saudação ao cliente (ex: "Olá! Obrigado pela pergunta..." ou "Oi! ...").`
}

export function buildSuggestQuestionUserPrompt(ctx: SuggestQuestionContext): string {
  const histBlock = (ctx.history && ctx.history.length > 0)
    ? 'HISTÓRICO P&R:\n' + ctx.history.slice(0, 10).map(h => `P:${h.question}\nR:${h.answer}`).join('\n')
    : 'HISTÓRICO P&R: (sem histórico)'
  const productLine = `${ctx.productTitle ?? '?'} | R$${ctx.productPrice ?? '?'} | ${ctx.productCondition ?? 'novo'} | ${ctx.availableQuantity ?? 0} em estoque`
  return `PRODUTO: ${productLine}\n${histBlock}\nPERGUNTA: ${ctx.questionText}\nResponda de forma direta e precisa.`
}

/**
 * Limpa markdown e prefixos "Resposta:" que o modelo às vezes acrescenta.
 * Migrado bit-a-bit do ml-questions-ai.service.ts.
 */
export function stripQuestionMarkdownHeader(raw: string): string {
  let text = raw.trim()
  while (/^\s*#{1,6}\s+/.test(text)) {
    text = text.replace(/^\s*#{1,6}\s+[^\n]*\n*/, '').trim()
  }
  text = text.replace(/^(?:#+\s*)?Resposta(\s+ao\s+Cliente)?\s*:?\s*/i, '').trim()
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  return text
}
