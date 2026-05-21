/**
 * Catalogo de estilos de banner do Store Builder v3.
 *
 * Cada estilo tem um template de prompt em PT-BR com placeholders no
 * formato `{{var}}` que sao resolvidos com dados reais dos produtos
 * selecionados pelo lojista no momento da geracao.
 *
 * Placeholders suportados:
 *  - {{product_name}}         (1o produto da lista)
 *  - {{product_short}}        (ai_short_description do 1o)
 *  - {{product_category}}     (categoria do 1o)
 *  - {{product_brand}}        (marca do 1o)
 *  - {{product_price}}        (formato R$ X,XX)
 *  - {{product_sale_price}}   (vazio se nao em promo)
 *  - {{discount_text}}        ('com 30% OFF' ou '' se sem desconto)
 *  - {{products_list}}        (descricao curta de todos quando bundle)
 *  - {{primary_color}}        (cor primaria do tema)
 *  - {{secondary_color}}      (cor de fundo do tema)
 *  - {{store_name}}           (nome da loja)
 *
 * Pra adicionar estilo novo: adiciona entry ao array BANNER_STYLES.
 */

export type BannerFormat = 'wide' | 'story' | 'square'

export interface BannerStyle {
  /** Identificador unico (kebab-case). */
  key:             string
  /** Nome PT-BR pro UI. */
  label:           string
  /** 1 frase descrevendo o resultado. */
  description:     string
  /** Categoria visual pro UI agrupar. */
  category:        'Promocional' | 'Lifestyle' | 'Minimalista' | 'Editorial' | 'Luxo' | 'Sazonal' | 'Criativo'
  /** Template do prompt (PT-BR, com placeholders). */
  promptTemplate:  string
  /** Formato sugerido. Lojista pode override. */
  defaultFormat:   BannerFormat
  /** Quantos produtos sao ideais pra esse estilo (min/max). */
  productRange:    { min: number; max: number }
}

export const BANNER_STYLES: BannerStyle[] = [
  {
    key: 'promocional-vibrante',
    label: 'Promocional Vibrante',
    description: 'Cores fortes, destaque do desconto, urgência. Ideal pra ofertas relâmpago.',
    category: 'Promocional',
    defaultFormat: 'wide',
    productRange: { min: 1, max: 1 },
    promptTemplate:
      'Banner promocional vibrante de e-commerce em alta resolução. Produto em destaque: {{product_name}} ({{product_category}}). ' +
      '{{discount_text}}. Composição com cores vivas e contrastes fortes ({{primary_color}} como cor principal). ' +
      'Tipografia bold com o preço {{product_sale_price}} muito destacado. Sensação de urgência. ' +
      'Estilo moderno, layout em formato wide pra topo de loja. Sem texto longo, sem watermark.',
  },
  {
    key: 'lifestyle-ambiente',
    label: 'Lifestyle / Ambiente',
    description: 'Produto em uso, cenário real e aconchegante. Conexão emocional.',
    category: 'Lifestyle',
    defaultFormat: 'wide',
    productRange: { min: 1, max: 1 },
    promptTemplate:
      'Banner lifestyle premium pra e-commerce de {{product_category}}. Cena fotorrealista com {{product_name}} ' +
      'em ambiente real e aconchegante (luz natural, decoração harmoniosa). Pessoa interagindo discretamente com o produto sem mostrar rosto. ' +
      'Paleta natural com {{primary_color}} como destaque sutil. ' +
      'Composição cinematográfica, profundidade de campo, formato wide. Sem texto sobreposto, sem marca d\'água.',
  },
  {
    key: 'minimalista-limpo',
    label: 'Minimalista Limpo',
    description: 'Produto isolado em fundo neutro. Foco total no produto.',
    category: 'Minimalista',
    defaultFormat: 'square',
    productRange: { min: 1, max: 1 },
    promptTemplate:
      'Banner minimalista premium de e-commerce. Foto do produto {{product_name}} ({{product_category}}) isolado em fundo neutro de cor {{secondary_color}}. ' +
      'Iluminação suave estilo studio, sombra muito leve. Composição ultra limpa, espaço negativo. ' +
      'Estética inspirada em Apple e marcas premium. Foco TOTAL no produto. ' +
      'Sem texto, sem marca d\'água, sem props.',
  },
  {
    key: 'editorial-revista',
    label: 'Editorial / Revista',
    description: 'Estilo magazine, foto cuidada, atmosfera sofisticada.',
    category: 'Editorial',
    defaultFormat: 'wide',
    productRange: { min: 1, max: 2 },
    promptTemplate:
      'Banner editorial estilo revista premium pra {{store_name}} ({{product_category}}). ' +
      'Composição inspirada em editoriais de Vogue/Kinfolk com {{product_name}}. ' +
      'Iluminação cinematográfica, atmosfera artística e sofisticada. ' +
      'Paleta sóbria com {{primary_color}} usado com elegância. ' +
      'Formato wide com muito espaço pra respiração visual. Sem texto sobreposto.',
  },
  {
    key: 'luxo-sofisticado',
    label: 'Luxo Sofisticado',
    description: 'Fundo escuro, dourado, atmosfera premium. Marcas high-end.',
    category: 'Luxo',
    defaultFormat: 'wide',
    productRange: { min: 1, max: 1 },
    promptTemplate:
      'Banner ultra premium de luxo pra e-commerce de {{product_category}}. ' +
      'Produto {{product_name}} em destaque sobre fundo escuro (preto profundo ou marrom rico). ' +
      'Iluminação dramática estilo joalheria/perfumaria de luxo, reflexos sutis. ' +
      'Detalhes dourados ou metálicos. Estética de marcas premium internacionais. ' +
      'Formato wide. Sem texto, sem watermark.',
  },
  {
    key: 'flat-lay',
    label: 'Flat Lay',
    description: 'Vista de cima com produto e props complementares.',
    category: 'Editorial',
    defaultFormat: 'square',
    productRange: { min: 1, max: 3 },
    promptTemplate:
      'Banner flat lay premium pra e-commerce. Vista de cima (top-down) com {{products_list}} ' +
      'arranjados harmoniosamente sobre superfície de tecido neutro ou madeira clara. ' +
      'Props sutis complementares ao tema ({{product_category}}). ' +
      'Iluminação natural difusa, sombras leves. Composição equilibrada e instagramável. ' +
      'Cor de destaque: {{primary_color}}. Sem texto sobreposto, sem marca d\'água.',
  },
  {
    key: 'bundle-combo',
    label: 'Bundle / Combo',
    description: 'Múltiplos produtos juntos, ideia de kit ou combinação.',
    category: 'Promocional',
    defaultFormat: 'wide',
    productRange: { min: 2, max: 5 },
    promptTemplate:
      'Banner promocional de bundle/combo pra e-commerce. {{products_list}} apresentados juntos como kit/combinação. ' +
      'Composição equilibrada destacando o conjunto. {{discount_text}}. ' +
      'Cores vibrantes com {{primary_color}} como acento. ' +
      'Sensação de oferta valiosa. Estilo moderno e atraente. Formato wide. ' +
      'Sem texto sobreposto, sem watermark.',
  },
  {
    key: 'sazonal-black-friday',
    label: 'Sazonal: Black Friday',
    description: 'Tema black friday — preto, vermelho, urgência máxima.',
    category: 'Sazonal',
    defaultFormat: 'wide',
    productRange: { min: 1, max: 3 },
    promptTemplate:
      'Banner BLACK FRIDAY de altíssimo impacto. {{product_name}} em destaque. ' +
      'Fundo preto profundo com elementos em vermelho/laranja vibrante. ' +
      'Tipografia ultra bold com {{discount_text}} sendo o foco visual. ' +
      'Sensação de urgência extrema, energia de mega promoção. ' +
      'Estilo moderno tipo Amazon Black Friday. Formato wide. Sem watermark.',
  },
  {
    key: 'sazonal-natal',
    label: 'Sazonal: Natal',
    description: 'Tema natalino — cores festivas, calor de fim de ano.',
    category: 'Sazonal',
    defaultFormat: 'wide',
    productRange: { min: 1, max: 3 },
    promptTemplate:
      'Banner natalino premium pra e-commerce. {{product_name}} ({{product_category}}) em cena de Natal aconchegante. ' +
      'Elementos festivos sutis (luzes douradas, pinheiro suave ao fundo, ou bokeh quente). ' +
      'Paleta verde/dourado/vermelho de Natal moderno, sem clichê. ' +
      'Sensação de calor familiar e celebração. Iluminação morna. Formato wide. Sem texto sobreposto.',
  },
  {
    key: 'storytelling-narrativa',
    label: 'Storytelling Narrativo',
    description: 'Banner com narrativa visual — conta uma história curta.',
    category: 'Criativo',
    defaultFormat: 'wide',
    productRange: { min: 1, max: 1 },
    promptTemplate:
      'Banner cinematográfico com storytelling visual pra {{product_name}} ({{product_category}}). ' +
      'Composição que sugere uma história ou momento (ex: alguém usando o produto no contexto perfeito, ' +
      'ou o produto sendo descoberto). Iluminação dramática e atmosférica. ' +
      'Cores em harmonia com {{primary_color}}. Sensação emocional e aspiracional. ' +
      'Formato wide. Sem texto sobreposto, sem watermark.',
  },
]

export const BANNER_STYLES_MAP: Record<string, BannerStyle> =
  Object.fromEntries(BANNER_STYLES.map(s => [s.key, s]))

// ─────────────────────────────────────────────────────────────────────────
// Resolve placeholders no template a partir dos dados reais dos produtos
// ─────────────────────────────────────────────────────────────────────────

export interface BannerProductInfo {
  id:                   string
  name:                 string
  short_description?:   string | null
  category?:            string | null
  brand?:               string | null
  price:                number
  sale_price?:          number | null
  photo_url?:           string | null
}

export interface BannerThemeInfo {
  primary_color?:    string
  secondary_color?:  string
  store_name?:       string
}

function fmtBRL(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function resolveBannerPrompt(
  template: string,
  products: BannerProductInfo[],
  theme: BannerThemeInfo,
  customAdditions?: string,
): string {
  const p0 = products[0]
  const hasSale = p0?.sale_price != null && p0.sale_price < p0.price
  const discountPct = hasSale && p0
    ? Math.round((1 - (p0.sale_price as number) / p0.price) * 100)
    : 0
  const productsList = products
    .map(p => `${p.name}${p.category ? ` (${p.category})` : ''}`)
    .join(', ')

  const vars: Record<string, string> = {
    product_name:        p0?.name ?? '',
    product_short:       p0?.short_description ?? '',
    product_category:    p0?.category ?? '',
    product_brand:       p0?.brand ?? '',
    product_price:       p0 ? fmtBRL(p0.price) : '',
    product_sale_price:  hasSale && p0 ? fmtBRL(p0.sale_price as number) : (p0 ? fmtBRL(p0.price) : ''),
    discount_text:       hasSale ? `Com ${discountPct}% de desconto` : '',
    products_list:       productsList,
    primary_color:       theme.primary_color ?? '#000000',
    secondary_color:     theme.secondary_color ?? '#ffffff',
    store_name:          theme.store_name ?? 'a loja',
  }

  let resolved = template
  for (const [k, v] of Object.entries(vars)) {
    resolved = resolved.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v)
  }
  // Limpa duplos espacos / vazios deixados por placeholders vazios.
  resolved = resolved.replace(/\s{2,}/g, ' ').replace(/\s+\./g, '.').trim()
  if (customAdditions?.trim()) {
    resolved += `\n\nInstruções extras do lojista: ${customAdditions.trim()}`
  }
  return resolved
}
