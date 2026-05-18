/**
 * Esquema da receita de design da Loja Propria — Tema Premium.
 *
 * ESPELHO de eclick-frontend/src/lib/storefront/types.ts — manter os dois
 * em sync (mesmo padrao do margin.ts). O backend gera/valida o design; o
 * frontend renderiza. Qualquer mudanca de campo aqui replica la.
 */

export type ThemeMode = 'dark' | 'light'
export type FontPair  = 'elegant' | 'modern' | 'bold' | 'classic' | 'editorial' | 'playful'
export type Radius    = 'none' | 'sm' | 'md' | 'lg'
export type Density   = 'compact' | 'cozy' | 'spacious'

export interface DesignColors {
  background: string
  surface:    string
  primary:    string
  text:       string
  textMuted:  string
  border:     string
  /** Fundo escuro de banners (announcement, marquee). */
  dark?:      string
  /** Cor do texto-watermark gigante ao fundo das secoes. */
  watermark?: string
  /** Cor do texto sobre a cor primaria (ex.: dentro de botoes). */
  onAccent?:  string
}

/** Efeitos globais ligaveis da vitrine. */
export interface DesignEffects {
  scrollReveal:  boolean
  watermarks:    boolean
  parallaxTilt:  boolean
  hoverRollover: boolean
}

export interface DesignTheme {
  mode:     ThemeMode
  colors:   DesignColors
  fontPair: FontPair
  radius:   Radius
  density:  Density
  /** Efeitos globais (opcional — cai no padrao quando ausente). */
  effects?: DesignEffects
}

// ─────────────────────────────────────────────────────────────────────
// Secoes do Tema Premium (estilo editorial/Renovate).
// ─────────────────────────────────────────────────────────────────────

/** Faixa superior com mensagem + countdown opcional. */
export interface AnnouncementBarSection {
  type:         'announcementBar'
  message:      string
  ctaLabel?:    string
  ctaHref?:     string
  /** ISO date — quando preenchido, renderiza um countdown ate essa data. */
  countdownTo?: string | null
}

/** Cabecalho rico — sticky, logo, navegacao, icones de busca/carrinho. */
export interface SiteHeaderSection {
  type:       'siteHeader'
  variant:    'centered' | 'split'
  sticky:     boolean
  showSearch: boolean
  showCart:   boolean
  nav:        Array<{ label: string; href: string }>
}

/** Hero com carrossel de cards verticais (coverflow) + watermark gigante. */
export interface HeroPortraitSection {
  type:         'heroPortrait'
  watermark?:   string
  headline:     string
  subheadline?: string
  ctaLabel?:    string
  slides:       Array<{ imageUrl: string; label?: string; href?: string }>
}

/** Vitrine de produtos — carrossel ou grade. Cobre "shop by room" e "trending". */
export interface ProductShowcaseSection {
  type:          'productShowcase'
  layout:        'carousel' | 'grid'
  title:         string
  watermark?:    string
  source:        'storefront' | 'collection' | 'manual'
  collectionId?: string | null
  productIds?:   string[]
  columns?:      { mobile: number; tablet: number; desktop: number }
}

/** Imagem de ambiente com pontos clicaveis (hotspots) que abrem produtos. */
export interface ImageHotspotSection {
  type:     'imageHotspot'
  title?:   string
  imageUrl: string
  hotspots: Array<{ xPct: number; yPct: number; productId?: string; label?: string }>
}

/** Grade de categorias/colecoes com thumbnail e contagem. */
export interface CategoryGridSection {
  type:       'categoryGrid'
  title:      string
  watermark?: string
  categories: Array<{ label: string; imageUrl: string; href?: string; count?: number }>
}

/** Banner de imagem cheia com efeito de inclinacao/parallax no scroll. */
export interface TiltBannerSection {
  type:       'tiltBanner'
  imageUrl:   string
  watermark?: string
  headline?:  string
}

/** Banner panoramico com titulo centralizado e CTA pill. */
export interface FullBannerSection {
  type:         'fullBanner'
  imageUrl:     string
  headline:     string
  subheadline?: string
  ctaLabel?:    string
  ctaHref?:     string
}

/** Faixa diagonal com texto rolando em loop (ticker). */
export interface MarqueeSection {
  type:  'marquee'
  items: string[]
}

/** Bloco editorial — texto de um lado, imagem do outro. */
export interface EditorialSplitSection {
  type:       'editorialSplit'
  title:      string
  body:       string
  imageUrl:   string
  imageSide:  'left' | 'right'
  ctaLabel?:  string
  ctaHref?:   string
}

/** Rodape rico — colunas de links, newsletter, redes sociais. */
export interface SiteFooterSection {
  type:        'siteFooter'
  variant:     'minimal' | 'columns'
  columns?:    Array<{ title: string; links: Array<{ label: string; href: string }> }>
  newsletter?: boolean
}

export type Section =
  | AnnouncementBarSection
  | SiteHeaderSection
  | HeroPortraitSection
  | ProductShowcaseSection
  | ImageHotspotSection
  | CategoryGridSection
  | TiltBannerSection
  | FullBannerSection
  | MarqueeSection
  | EditorialSplitSection
  | SiteFooterSection

export type SectionType = Section['type']

export interface ProductPageDesign {
  gallery:        'side' | 'top'
  showAttributes: boolean
  ctaMode:        'whatsapp' | 'cart'
}

export interface StorefrontDesign {
  /** Sempre 2 — versao do esquema da receita de design. */
  version:  2
  theme:    DesignTheme
  sections: Section[]
  product:  ProductPageDesign
}

// Conjuntos de valores validos — usados pelo validador runtime.
export const THEME_MODES:  readonly ThemeMode[] = ['dark', 'light']
export const FONT_PAIRS:   readonly FontPair[]  = ['elegant', 'modern', 'bold', 'classic', 'editorial', 'playful']
export const RADII:        readonly Radius[]    = ['none', 'sm', 'md', 'lg']
export const DENSITIES:    readonly Density[]   = ['compact', 'cozy', 'spacious']
