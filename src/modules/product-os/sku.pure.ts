/**
 * Product OS — regras PURAS do SKU (sem banco, sem Nest).
 *
 * Mora fora do sku.service porque é aqui que estão as decisões que quebram
 * dinheiro se saírem erradas (formato do SKU, eixos de variação) — e só dá pra
 * testar de verdade o que não depende do Supabase.
 */

export type SkuKind = 'marca' | 'categoria' | 'sub' | 'linha' | 'caracteristica' | 'cor' | 'tamanho'

export const KINDS: SkuKind[] = ['marca', 'categoria', 'sub', 'linha', 'caracteristica', 'cor', 'tamanho']

/** Pai esperado de cada kind (null = topo). Define a hierarquia.
 *  Linha é COLEÇÃO TRANSVERSAL (topo); Característica vive DENTRO da linha.
 *  Cor e Tamanho são os EIXOS DE VARIAÇÃO — topo, ortogonais entre si e ao
 *  modelo (o mesmo "Creme" serve a qualquer produto, o mesmo "G" também). */
export const PARENT_KIND: Record<SkuKind, SkuKind | null> = {
  marca: null, categoria: null, cor: null, tamanho: null, linha: null, sub: 'categoria', caracteristica: 'linha',
}

/** Kinds cujo código é ALFANUMÉRICO em vez do sequencial de 2 dígitos.
 *  Marca é VZ. Tamanho é G/M/P/GG — um "01/02" aqui destruiria a legibilidade
 *  justo no eixo que o humano mais lê ("VZ-07010202-47-G" se lê, "-01" não). */
export const ALPHA_KINDS: SkuKind[] = ['marca', 'tamanho']

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/** Normaliza rótulo p/ comparação: sem acento, sem espaço duplo, minúsculo.
 *  É o que impede "Giratório" e "Giratorio" virarem dois códigos. */
export function normLabel(s: string): string {
  return String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Sanitiza um código alfanumérico digitado pelo usuário (VZ, G, GG, XL). */
export function sanitizeAlphaCode(code: string, maxLen = 3): string {
  return String(code ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, maxLen)
}

/**
 * Deriva o código de um tamanho a partir do rótulo, quando o usuário não
 * informa: "Grande"→G, "Médio"→M, "GG"→GG, "XL"→XL, "Pequeno"→P.
 * Regra: rótulo curto (≤3 após limpar) vira o próprio código; longo vira a
 * INICIAL. Devolve '' se não sobrar nada utilizável — o chamador cai no
 * sequencial numérico.
 */
export function deriveAlphaCode(label: string): string {
  const clean = sanitizeAlphaCode(label, 64)
  if (!clean) return ''
  if (clean.length <= 3) return clean
  return clean[0]
}

/** Monta o sku_base no formato MARCA-MIOLO (ex: VZ-07010202). */
export function buildBase(marcaCode: string, categoriaCode: string, subCode: string, linhaCode: string, caracCode: string): string {
  return `${marcaCode}-${categoriaCode}${subCode}${linhaCode}${caracCode}`
}

/**
 * SKU da variante. Tamanho é SUFIXO OPCIONAL — sem ele o SKU sai idêntico ao
 * que sempre saiu (`base-cor`), que é o que mantém permanente todo Master SKU
 * já publicado. Nunca inverter a ordem: `base-cor-tamanho`.
 */
export function buildVariantSku(base: string, corCode: string, tamanhoCode?: string | null): string {
  const tam = (tamanhoCode ?? '').trim()
  return tam ? `${base}-${corCode}-${tam}` : `${base}-${corCode}`
}

// ── Ponte com o catálogo (products.variations[] jsonb) ───────────────

export interface VariantAxes { corLabel: string; tamanhoLabel?: string | null }

/**
 * Nome do eixo gravado em `variations[].type`. É o TIER da Shopee e o rótulo do
 * dropdown do comprador, então é uniforme no produto inteiro: se QUALQUER
 * variante tem tamanho, o produto é "Cor + Tamanho".
 */
export function variationType(rows: VariantAxes[]): string {
  return rows.some(r => (r.tamanhoLabel ?? '').trim()) ? 'Cor + Tamanho' : 'Cor'
}

/** Rótulo que o comprador vê. 2 eixos = "Creme / G" (mesmo separador que o ML
 *  usa ao LER attribute_combinations, mercadolivre.service.ts:937). */
export function variationValue(axes: VariantAxes): string {
  const tam = (axes.tamanhoLabel ?? '').trim()
  return tam ? `${axes.corLabel} / ${tam}` : axes.corLabel
}

/**
 * Fonte de verdade ESTRUTURADA dos eixos, aditiva ao `type`/`value`.
 * `type`/`value` são strings opacas: dá pra exibir, não dá pra decompor. Sem
 * isto, um publish futuro no ML não teria como montar attribute_combinations
 * ({COLOR:'Creme'},{SIZE:'G'}) a partir de "Creme / G".
 */
export function variationAttributes(axes: VariantAxes): Record<string, string> {
  const tam = (axes.tamanhoLabel ?? '').trim()
  return tam ? { Cor: axes.corLabel, Tamanho: tam } : { Cor: axes.corLabel }
}
