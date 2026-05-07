// Prompt do detector híbrido de exclusão de reclamação ML.
// Roda APENAS depois de regex match + claim aberto (filtro pré-LLM).

export interface ClaimRemovalPromptContext {
  message:                string
  matchedKeywords:        string[]
  claimReason:            string | null
  claimDaysOpen:          number
  shippingStatus:         string | null
  conversationSummary:    string | null
}

export const CLAIM_REMOVAL_SYSTEM_PROMPT = `Você analisa se uma mensagem de comprador no Mercado Livre indica que uma reclamação aberta pode ser excluída/encerrada.

CRITÉRIOS PARA isCandidate=true:
- Comprador disse explicitamente que abriu por engano
- Comprador disse que está tudo resolvido / produto chegou
- Comprador não reconhece a compra (golpe/fraude)
- Comprador pede para encerrar/cancelar a reclamação

CRITÉRIOS PARA isCandidate=false:
- Comprador ainda reclama do produto
- Comprador apenas conversando sem mencionar a reclamação
- Mensagem ambígua

CONFIDENCE:
- "high": comprador foi explícito (ex: "abri por engano", "pode cancelar a reclamação")
- "medium": forte indicativo mas não explícito (ex: "produto chegou tudo certo")
- "low": apenas pista fraca

Retorne APENAS JSON válido sem markdown:
{
  "isCandidate": boolean,
  "confidence": "low" | "medium" | "high",
  "reason": "frase curta (≤120 chars) explicando porque",
  "suggestedAction": "o que o atendente deve fazer (≤120 chars)",
  "suggestedRequestText": "texto cordial pra atendente enviar ao ML solicitando exclusão (≤350 chars), ou null se não aplicável"
}`

export function buildClaimRemovalUserPrompt(ctx: ClaimRemovalPromptContext): string {
  const lines: string[] = []
  lines.push(`Mensagem do comprador:\n${ctx.message}`)
  lines.push('')
  lines.push(`Keywords matched (regex): ${ctx.matchedKeywords.join(', ') || '(nenhuma)'}`)
  lines.push('')
  lines.push(`Reclamação aberta há ${ctx.claimDaysOpen} dia(s). Motivo: ${ctx.claimReason ?? 'não informado'}.`)
  if (ctx.shippingStatus) lines.push(`Status do envio: ${ctx.shippingStatus}`)
  if (ctx.conversationSummary) {
    lines.push('')
    lines.push(`Histórico recente:\n${ctx.conversationSummary}`)
  }
  return lines.join('\n')
}
