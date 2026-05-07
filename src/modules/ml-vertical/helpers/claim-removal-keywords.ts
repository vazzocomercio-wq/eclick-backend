/**
 * Regex de gatilho pra detector híbrido de exclusão de reclamação.
 * Captura padrões em PT-BR de:
 *   - arrependimento (abriu por engano)
 *   - resolução (chegou tudo certo)
 *   - não-reconhecimento (não fui eu, hackearam)
 *   - solicitação explícita (cancelar/encerrar reclamação)
 *
 * Match SEM contexto de claim aberto NÃO dispara LLM (poupança de custo).
 * Esse filtro fica no service.
 */
export const CLAIM_REMOVAL_KEYWORDS: RegExp[] = [
  // Arrependimento
  /abri\s+(a\s+)?reclama[çc][ãa]o\s+(por\s+engano|sem\s+querer)/i,
  /n[ãa]o\s+era\s+pra\s+ter\s+aberto/i,
  /(engano|erro)\s+meu/i,
  /me\s+arrependi/i,
  /foi\s+sem\s+querer/i,

  // Resolvido
  /est[áa]\s+tudo\s+(certo|bem|ok)/i,
  /(tudo\s+)?resolvido/i,
  /j[áa]\s+chegou/i,
  /recebi\s+(o\s+produto|a\s+encomenda|o\s+pedido)/i,
  /chegou\s+(tudo\s+)?(certo|bem|ok)/i,

  // Não reconhece compra
  /n[ãa]o\s+(reconhe[çc]o|fiz)\s+(essa\s+)?compra/i,
  /n[ãa]o\s+fui\s+eu/i,
  /(fui\s+)?hackead[oa]/i,
  /clonaram\s+(meu|minha)/i,

  // Solicita encerramento
  /(quero|posso|como)\s+(cancelar|encerrar|remover|deletar|tirar|excluir|fechar)\s+(a\s+)?reclama[çc][ãa]o/i,
  /pode\s+(cancelar|encerrar|fechar)\s+a?\s*reclama[çc][ãa]o/i,
]

export function matchClaimRemovalKeywords(text: string): string[] {
  if (!text?.trim()) return []
  const matched: string[] = []
  for (const re of CLAIM_REMOVAL_KEYWORDS) {
    if (re.test(text)) matched.push(re.source)
  }
  return matched
}
