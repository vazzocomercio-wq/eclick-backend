// Prompt do classificador pós-venda. Modelo deve devolver APENAS JSON válido.
// Saída validada com zod no service antes de gravar.

export const CLASSIFIER_INTENTS = [
  'duvida',
  'entrega',
  'atraso',
  'nota_fiscal',
  'produto_errado',
  'defeito',
  'incompleto',
  'devolucao',
  'cancelamento',
  'irritado',
  'ameaca_reclamacao',
  'reclamacao_aberta',
  'mediacao',
  'spam',
  'fora_escopo',
] as const
export type ClassifierIntent = typeof CLASSIFIER_INTENTS[number]

export const CLASSIFIER_SENTIMENTS = ['positivo', 'neutro', 'negativo', 'muito_negativo'] as const
export type ClassifierSentiment = typeof CLASSIFIER_SENTIMENTS[number]

export const CLASSIFIER_URGENCIES = ['baixa', 'media', 'alta', 'critica'] as const
export type ClassifierUrgency = typeof CLASSIFIER_URGENCIES[number]

export const CLASSIFIER_RISKS = ['baixo', 'medio', 'alto', 'critico'] as const
export type ClassifierRisk = typeof CLASSIFIER_RISKS[number]

export interface ClassifierContext {
  productTitle?: string
  shippingStatus?: string
  buyerNickname?: string
  conversationSummary?: string
}

export const CLASSIFIER_SYSTEM_PROMPT = `Você é um classificador de mensagens pós-venda do Mercado Livre.
Classifique a mensagem do comprador retornando APENAS um JSON válido com EXATAMENTE estes campos:

{
  "intent": "duvida" | "entrega" | "atraso" | "nota_fiscal" | "produto_errado" | "defeito" | "incompleto" | "devolucao" | "cancelamento" | "irritado" | "ameaca_reclamacao" | "reclamacao_aberta" | "mediacao" | "spam" | "fora_escopo",
  "sentiment": "positivo" | "neutro" | "negativo" | "muito_negativo",
  "urgency": "baixa" | "media" | "alta" | "critica",
  "risk": "baixo" | "medio" | "alto" | "critico",
  "canAutoReply": false
}

Regras de risk:
- "muito_negativo" + ("ameaca_reclamacao" OU "produto_errado" OU "defeito") => risk "critico"
- "negativo" + "atraso" => risk "alto"
- "neutro" + "duvida" => risk "baixo"
- "ameaca_reclamacao" OU "reclamacao_aberta" OU "mediacao" => risk no mínimo "alto"

Regras de canAutoReply: SEMPRE false no MVP 1.

Sem markdown. Sem texto fora do JSON.`

export function buildClassifierUserPrompt(text: string, ctx?: ClassifierContext): string {
  const lines: string[] = []
  if (ctx?.productTitle)        lines.push(`Produto: ${ctx.productTitle}`)
  if (ctx?.shippingStatus)      lines.push(`Status do envio: ${ctx.shippingStatus}`)
  if (ctx?.buyerNickname)       lines.push(`Comprador: ${ctx.buyerNickname}`)
  if (ctx?.conversationSummary) lines.push(`Histórico curto: ${ctx.conversationSummary}`)
  const ctxBlock = lines.length > 0 ? lines.join('\n') : '(sem contexto adicional)'
  return `Contexto:\n${ctxBlock}\n\nMensagem do comprador:\n${text}`
}
