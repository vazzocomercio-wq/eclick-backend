/** Junta descrição + Destaques (bullets) + Perguntas frequentes (FAQ) num único
 *  texto. Usado nas PUBLICAÇÕES de marketplace que NÃO têm campo separado de
 *  destaques/FAQ (Mercado Livre, Shopee): a descrição editável do anúncio fica
 *  LIMPA e a composição acontece só na hora de publicar, sempre com o estado
 *  mais recente dos bullets/FAQ.
 *
 *  ⚠️ NÃO usar na Loja própria: a vitrine tem seções próprias de bullets e FAQ
 *  (campos `products.bullets` / `products.faq`), então lá os destaques/FAQ são
 *  sincronizados como CAMPOS (não jogados na descrição) pra não duplicar.
 */
export function composeListingDescription(
  description?: string | null,
  // bullets/faq vêm como jsonb (tipo solto) — tratados defensivamente
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bullets?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  faq?: any,
): string {
  const parts: string[] = []

  const body = (description ?? '').toString().trim()
  if (body) parts.push(body)

  const bl = (Array.isArray(bullets) ? bullets : [])
    .map((b: unknown) => (b ?? '').toString().trim())
    .filter(Boolean)
  if (bl.length) {
    parts.push(['Destaques:', ...bl.map((b: string) => `• ${b}`)].join('\n'))
  }

  const fq = (Array.isArray(faq) ? faq : [])
    .map((f: { q?: string; a?: string } | null) => ({
      q: (f?.q ?? '').toString().trim(),
      a: (f?.a ?? '').toString().trim(),
    }))
    .filter((f) => f.q || f.a)
  if (fq.length) {
    parts.push(['Perguntas frequentes:', ...fq.map((f) => `P: ${f.q}\nR: ${f.a}`)].join('\n\n'))
  }

  return parts.join('\n\n')
}
