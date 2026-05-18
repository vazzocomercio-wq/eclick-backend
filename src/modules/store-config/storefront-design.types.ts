/**
 * Esquema da receita de design da Loja Propria.
 *
 * ESPELHO de eclick-frontend/src/lib/storefront/types.ts — manter os dois
 * em sync (mesmo padrao do margin.ts). O backend gera/valida o design; o
 * frontend renderiza. Qualquer mudanca de campo aqui replica la.
 */

export type ThemeMode = 'dark' | 'light'
export type FontPair  = 'elegant' | 'modern' | 'bold' | 'classic'
export type Radius    = 'none' | 'sm' | 'md' | 'lg'
export type Density   = 'compact' | 'cozy' | 'spacious'

export interface DesignColors {
  background: string
  surface:    string
  primary:    string
  text:       string
  textMuted:  string
  border:     string
}

export interface DesignTheme {
  mode:     ThemeMode
  colors:   DesignColors
  fontPair: FontPair
  radius:   Radius
  density:  Density
}

export interface HeaderSection {
  type:    'header'
  variant: 'minimal' | 'centered' | 'overlay'
}

export interface HeroSection {
  type:        'hero'
  variant:     'gradient' | 'image' | 'split'
  headline:    string
  subheadline: string
  ctaLabel:    string
  imageUrl?:   string | null
}

export interface CollectionsSection {
  type:    'collections'
  variant: 'strip' | 'grid'
  title:   string
}

export interface ProductGridSection {
  type:    'productGrid'
  variant: 'compact' | 'elevated' | 'editorial'
  title:   string
  columns: { mobile: number; tablet: number; desktop: number }
}

export interface AboutSection {
  type:    'about'
  variant: 'simple' | 'banner'
  title:   string
  body:    string
}

export interface FooterSection {
  type:    'footer'
  variant: 'minimal' | 'full'
}

export type Section =
  | HeaderSection
  | HeroSection
  | CollectionsSection
  | ProductGridSection
  | AboutSection
  | FooterSection

export interface ProductPageDesign {
  gallery:        'side' | 'top'
  showAttributes: boolean
  ctaMode:        'whatsapp' | 'cart'
}

export interface StorefrontDesign {
  version:  1
  theme:    DesignTheme
  sections: Section[]
  product:  ProductPageDesign
}

// Conjuntos de valores validos — usados pelo validador runtime.
export const THEME_MODES:  readonly ThemeMode[] = ['dark', 'light']
export const FONT_PAIRS:   readonly FontPair[]  = ['elegant', 'modern', 'bold', 'classic']
export const RADII:        readonly Radius[]    = ['none', 'sm', 'md', 'lg']
export const DENSITIES:    readonly Density[]   = ['compact', 'cozy', 'spacious']
