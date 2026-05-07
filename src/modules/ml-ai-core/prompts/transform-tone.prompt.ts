// Reescreve mantendo ≤350 chars. Tom muda mas o conteúdo essencial é
// preservado. Sem markdown, sem emojis.

import { POSTSALE_MAX_CHARS } from './suggest-postsale.prompt'

export const TONE_VARIANTS = ['mais_empatico', 'mais_objetivo'] as const
export type ToneVariant = typeof TONE_VARIANTS[number]

const TONE_INSTRUCTIONS: Record<ToneVariant, string> = {
  mais_empatico:  'Reescreva com tom MAIS empático e acolhedor, reconhecendo o sentimento do comprador, sem perder objetividade.',
  mais_objetivo:  'Reescreva com tom MAIS direto e objetivo, mantendo a cordialidade mas indo ao ponto.',
}

export function buildTransformToneSystemPrompt(tone: ToneVariant): string {
  return `Você é editor de texto pra atendimento pós-venda do Mercado Livre.
${TONE_INSTRUCTIONS[tone]}

REGRAS:
1. Saída tem NO MÁXIMO ${POSTSALE_MAX_CHARS} caracteres (incluindo espaços e pontuação).
2. NUNCA peça telefone, WhatsApp, email ou redes sociais.
3. NUNCA envie links externos.
4. NUNCA prometa prazo, desconto ou reembolso novos.
5. Sem markdown, sem emojis, sem títulos.
6. Saída só o texto reescrito, em PT-BR.`
}

export function buildTransformToneUserPrompt(text: string): string {
  return `Reescreva mantendo a essência:\n\n${text.trim()}`
}
