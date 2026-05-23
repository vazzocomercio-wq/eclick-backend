/**
 * Esquema v3 da receita de design da Loja Propria (Store Builder).
 *
 * ESPELHO de eclick-frontend/src/lib/storefront/v3/types.ts — manter os
 * dois em sync. O backend gera/valida o design; o frontend renderiza.
 * Qualquer mudanca de campo aqui replica la.
 *
 * Diferencas vs v2 (storefront-design.types.ts):
 *  - Section e container com `blocks` internos (Shopify OS 2.0 style)
 *  - 5 paginas editaveis: home, product, collection, cart, checkout
 *  - Header/Footer sao globals compartilhados
 *  - mobileOverrides por secao e por bloco
 *  - Spacing/Background por secao
 *  - IDs uuid em secoes e blocos
 */

// ─────────────────────────────────────────────────────────────────────────
// Tema
// ─────────────────────────────────────────────────────────────────────────

export type ThemeMode = 'dark' | 'light'
// FontPair vem do dicionario central pra escalar (30 pares).
export type { FontPair } from './storefront-design-v3.font-pairs'
import type { FontPair as _FP } from './storefront-design-v3.font-pairs'
type FontPair = _FP
export type Radius    = 'none' | 'sm' | 'md' | 'lg' | 'full'
export type Density   = 'compact' | 'cozy' | 'spacious'
export type ButtonStyleKind = 'solid' | 'outline' | 'pill' | 'sharp'
export type ButtonWeight    = 'normal' | 'bold'

export interface DesignColorsV3 {
  background: string
  surface:    string
  primary:    string
  text:       string
  textMuted:  string
  border:     string
  dark?:      string
  watermark?: string
  onAccent?:  string
  success?:   string
  error?:     string
  warning?:   string
}

export interface DesignEffects {
  scrollReveal:  boolean
  watermarks:    boolean
  parallaxTilt:  boolean
  hoverRollover: boolean
}

export interface ThemeButtons {
  style:  ButtonStyleKind
  weight: ButtonWeight
}

export interface ThemeV3 {
  mode:     ThemeMode
  colors:   DesignColorsV3
  fontPair: FontPair
  customFonts?: {
    heading?:         string
    body?:            string
    googleFamilies?:  string[]
  }
  radius:   Radius
  density:  Density
  effects:  DesignEffects
  buttons:  ThemeButtons
}

// ─────────────────────────────────────────────────────────────────────────
// Background / Spacing / Visibility
// ─────────────────────────────────────────────────────────────────────────

export type BackgroundKind = 'none' | 'color' | 'image' | 'video' | 'gradient'

export interface BackgroundStyle {
  kind:        BackgroundKind
  color?:      string
  imageUrl?:   string
  imageFocus?: 'center' | 'top' | 'bottom' | 'left' | 'right'
  videoUrl?:   string
  gradient?:   { from: string; to: string; angle?: number }
  overlayColor?: string
  overlayOpacity?: number
}

export interface Spacing {
  paddingTop:    number
  paddingBottom: number
  marginTop:     number
  marginBottom:  number
}

export interface Visibility {
  desktop: boolean
  mobile:  boolean
}

/** Override de tipografia por seção (opcional) — espelho do frontend. */
export interface SectionTypography {
  textColor?:  string
  mutedColor?: string
  fontPair?:   FontPair
}

// ─────────────────────────────────────────────────────────────────────────
// Blocks (atomos)
// ─────────────────────────────────────────────────────────────────────────

export type BlockType =
  | 'heading'
  | 'subheading'
  | 'paragraph'
  | 'image'
  | 'video'
  | 'button'
  | 'badge'
  | 'countdown'
  | 'divider'
  | 'spacer'
  | 'icon'
  | 'productCardMini'
  | 'collectionLink'
  | 'socialIcon'
  | 'slide'

export interface BlockBase<T extends BlockType, S> {
  id:        string
  type:      T
  settings:  S
  mobileOverrides?: Partial<S>
}

export type HeadingBlock = BlockBase<'heading', {
  text:  string
  level: 1 | 2 | 3 | 4
  align: 'left' | 'center' | 'right'
}>

export type SubheadingBlock = BlockBase<'subheading', {
  text:  string
  align: 'left' | 'center' | 'right'
}>

export type ParagraphBlock = BlockBase<'paragraph', {
  text:  string
  align: 'left' | 'center' | 'right'
}>

export type ImageBlock = BlockBase<'image', {
  url:          string
  alt:          string
  link?:        string
  aspectRatio:  '1:1' | '4:5' | '16:9' | '3:2' | 'free'
  objectFit:    'cover' | 'contain'
}>

export type VideoBlock = BlockBase<'video', {
  url:        string
  autoplay:   boolean
  loop:       boolean
  muted:      boolean
  controls:   boolean
  poster?:    string
}>

export type ButtonBlock = BlockBase<'button', {
  label:  string
  href:   string
  style:  'primary' | 'secondary' | 'ghost'
  size:   'sm' | 'md' | 'lg'
  icon?:  string
  newTab: boolean
}>

export type BadgeBlock = BlockBase<'badge', {
  text:  string
  color: 'primary' | 'success' | 'error' | 'warning'
}>

export type CountdownBlock = BlockBase<'countdown', {
  endsAt: string
  label?: string
}>

export type DividerBlock = BlockBase<'divider', {
  style:  'solid' | 'dashed' | 'dotted'
  color?: string
}>

export type SpacerBlock = BlockBase<'spacer', {
  height: number
}>

export type IconBlock = BlockBase<'icon', {
  name:  string
  size:  number
  color?: string
}>

export type ProductCardMiniBlock = BlockBase<'productCardMini', {
  productId:    string
  showPrice:    boolean
  showCta:      boolean
}>

export type CollectionLinkBlock = BlockBase<'collectionLink', {
  collectionId: string
  label:        string
  imageUrl?:    string
}>

export type SocialIconBlock = BlockBase<'socialIcon', {
  network: 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'twitter' | 'whatsapp' | 'pinterest'
  href:    string
}>

export type SlideBlock = BlockBase<'slide', {
  imageUrl:     string
  headline?:    string
  subheadline?: string
  ctaLabel?:    string
  ctaHref?:     string
  textColor?:   string
  textAlign?:   'left' | 'center' | 'right'
  overlayColor?:   string
  overlayOpacity?: number
}>

export type Block =
  | HeadingBlock | SubheadingBlock | ParagraphBlock
  | ImageBlock | VideoBlock
  | ButtonBlock | BadgeBlock | CountdownBlock
  | DividerBlock | SpacerBlock | IconBlock
  | ProductCardMiniBlock | CollectionLinkBlock | SocialIconBlock
  | SlideBlock

// ─────────────────────────────────────────────────────────────────────────
// Sections (containers — 20 tipos)
// ─────────────────────────────────────────────────────────────────────────

export type SectionType =
  | 'siteHeader' | 'siteFooter' | 'announcementBar' | 'breadcrumb'
  | 'hero' | 'slider' | 'imageBanner' | 'imageHotspot' | 'imageWithText' | 'marquee'
  | 'productGrid' | 'productCarousel' | 'featuredProduct' | 'collectionGrid' | 'productDetailLayout' | 'productKits'
  | 'richText' | 'testimonials' | 'logoList' | 'faq' | 'newsletter' | 'videoBlock' | 'customHtml'
  | 'cartLayout' | 'checkoutLayout' | 'whatsappCatalog'
  | 'leadForm'
  | 'roomVisualizer'

export interface SectionBase<T extends SectionType, S> {
  id:           string
  type:         T
  settings:     S
  blocks:       Block[]
  visibility:   Visibility
  spacing:      Spacing
  background:   BackgroundStyle
  typography?:  SectionTypography
  mobileOverrides?: {
    settings?:   Partial<S>
    spacing?:    Partial<Spacing>
    background?: Partial<BackgroundStyle>
  }
}

export type SiteHeaderSection = SectionBase<'siteHeader', {
  variant:    'centered' | 'split' | 'minimal'
  sticky:     boolean
  showSearch: boolean
  showCart:   boolean
  showAccount: boolean
  logoUrl?:   string
  logoText?:  string
  /** Altura maxima da imagem do logo em px (default 40, range 24-120). */
  logoMaxHeight?: number
  nav:        Array<{ label: string; href: string; submenu?: Array<{ label: string; href: string }> }>
}>

export type SiteFooterSection = SectionBase<'siteFooter', {
  variant:           'minimal' | 'columns'
  columns?:          Array<{ title: string; links: Array<{ label: string; href: string }> }>
  showNewsletter:    boolean
  showSocialIcons:   boolean
  showPaymentMethods: boolean
  copyright?:        string
}>

export type AnnouncementBarSection = SectionBase<'announcementBar', {
  message:       string
  ctaLabel?:     string
  ctaHref?:      string
  countdownTo?:  string | null
  dismissible:   boolean
}>

export type BreadcrumbSection = SectionBase<'breadcrumb', {
  showHome: boolean
  separator: '/' | '>' | '·'
}>

export type HeroSection = SectionBase<'hero', {
  layout:       'split' | 'centered' | 'overlay'
  height:       'auto' | 'sm' | 'md' | 'lg' | 'fullscreen' | 'custom'
  customHeight?: number
  textAlign:    'left' | 'center' | 'right'
}>

export type SliderSection = SectionBase<'slider', {
  autoplay:     boolean
  interval:     number
  showDots:     boolean
  showArrows:   boolean
  effect:       'fade' | 'slide' | 'coverflow'
  height:       'auto' | 'sm' | 'md' | 'lg' | 'fullscreen' | 'custom'
  customHeight?: number
}>

export type ImageBannerSection = SectionBase<'imageBanner', {
  imageUrl:     string
  headline?:    string
  subheadline?: string
  ctaLabel?:    string
  ctaHref?:     string
  textPosition: 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right'
  height:       'sm' | 'md' | 'lg' | 'fullscreen' | 'custom'
  customHeight?: number
}>

export type ImageHotspotSection = SectionBase<'imageHotspot', {
  title?:   string
  imageUrl: string
  hotspots: Array<{ id: string; xPct: number; yPct: number; productId?: string; label?: string }>
}>

export type ImageWithTextSection = SectionBase<'imageWithText', {
  imageUrl:  string
  imageSide: 'left' | 'right'
  title:     string
  body:      string
  ctaLabel?: string
  ctaHref?:  string
}>

export type MarqueeSection = SectionBase<'marquee', {
  items:    string[]
  speed:    'slow' | 'normal' | 'fast'
  direction: 'left' | 'right'
}>

export type ProductSource =
  | { kind: 'storefront' }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'manual'; productIds: string[] }
  | { kind: 'bestsellers' }
  | { kind: 'newest' }
  | { kind: 'promo' }

export type ProductGridSection = SectionBase<'productGrid', {
  title?:    string
  source:    ProductSource
  columns:   { mobile: 1 | 2; tablet: 2 | 3 | 4; desktop: 2 | 3 | 4 | 5 | 6 }
  limit:     number
  showFilters: boolean
  showSort:    boolean
  cardStyle: 'compact' | 'detailed' | 'minimal'
}>

export type ProductCarouselSection = SectionBase<'productCarousel', {
  title?:    string
  source:    ProductSource
  limit:     number
  autoplay:  boolean
  cardStyle: 'compact' | 'detailed' | 'minimal'
}>

export type FeaturedProductSection = SectionBase<'featuredProduct', {
  productId:        string
  galleryPosition:  'left' | 'right' | 'top'
  showDescription:  boolean
  showAttributes:   boolean
  ctaLabel?:        string
}>

export type CollectionGridSection = SectionBase<'collectionGrid', {
  title?:     string
  columns:    { mobile: 1 | 2; tablet: 2 | 3 | 4; desktop: 2 | 3 | 4 | 5 | 6 }
  collections: Array<{ collectionId: string; label?: string; imageUrl?: string }>
}>

export type ProductDetailLayoutSection = SectionBase<'productDetailLayout', {
  galleryPosition:     'left' | 'right' | 'top'
  galleryStyle:        'carousel' | 'stack' | 'grid'
  stickyAddToCart:     boolean
  showShareButtons:    boolean
  showRelatedProducts: boolean
  relatedProductsCount: number
  showReviews:         boolean
}>

export type RichTextSection = SectionBase<'richText', {
  content: string
  maxWidth: 'sm' | 'md' | 'lg' | 'full'
  align:    'left' | 'center' | 'right'
}>

export type TestimonialsSection = SectionBase<'testimonials', {
  title?: string
  layout: 'carousel' | 'grid'
  items:  Array<{
    id:      string
    name:    string
    avatar?: string
    text:    string
    rating?: 1 | 2 | 3 | 4 | 5
  }>
}>

export type LogoListSection = SectionBase<'logoList', {
  title?: string
  logos:  Array<{ id: string; imageUrl: string; alt: string; href?: string }>
  grayscale: boolean
}>

export type FaqSection = SectionBase<'faq', {
  title?: string
  items:  Array<{ id: string; question: string; answer: string }>
}>

export type NewsletterSection = SectionBase<'newsletter', {
  title?:       string
  description?: string
  ctaLabel:     string
  placeholder:  string
  successMessage: string
}>

export type VideoBlockSection = SectionBase<'videoBlock', {
  url:        string
  autoplay:   boolean
  loop:       boolean
  muted:      boolean
  poster?:    string
  aspectRatio: '16:9' | '4:3' | '1:1' | '9:16'
}>

export type CustomHtmlSection = SectionBase<'customHtml', {
  html: string
  css?: string
}>

export type CartLayoutSection = SectionBase<'cartLayout', {
  showCoupon:     boolean
  showShipping:   boolean
  showNotes:      boolean
  trustBadges:    string[]
  upsellSource?:  ProductSource
}>

export type CheckoutLayoutSection = SectionBase<'checkoutLayout', {
  steps:           'multi' | 'single'
  requireAccount:  boolean
  askForCpf:       boolean
  askForCnpj:      boolean
  trustBadges:     string[]
}>

export type WhatsappCatalogSection = SectionBase<'whatsappCatalog', {
  enabled:  boolean
  position: 'header' | 'footer' | 'floating'
  label:    string
}>

export type Section =
  | SiteHeaderSection | SiteFooterSection | AnnouncementBarSection | BreadcrumbSection
  | HeroSection | SliderSection | ImageBannerSection | ImageHotspotSection | ImageWithTextSection | MarqueeSection
  | ProductGridSection | ProductCarouselSection | FeaturedProductSection | CollectionGridSection | ProductDetailLayoutSection
  | RichTextSection | TestimonialsSection | LogoListSection | FaqSection | NewsletterSection | VideoBlockSection | CustomHtmlSection
  | CartLayoutSection | CheckoutLayoutSection | WhatsappCatalogSection

// ─────────────────────────────────────────────────────────────────────────
// Paginas e raiz
// ─────────────────────────────────────────────────────────────────────────

export interface PageSeo {
  title?:       string
  description?: string
  ogImage?:     string
}

export interface PageDesign {
  sections: Section[]
  seo:      PageSeo
  layout?:  'default' | 'sidebar' | 'fullwidth'
}

export interface PageMap {
  home:       PageDesign
  product:    PageDesign
  collection: PageDesign
  cart:       PageDesign
  checkout:   PageDesign
}

export interface DesignGlobals {
  header: SiteHeaderSection
  footer: SiteFooterSection
}

export interface DesignMeta {
  templateKey: string
  updatedAt:   string
}

export interface StorefrontDesignV3 {
  version:  3
  theme:    ThemeV3
  globals:  DesignGlobals
  pages:    PageMap
  meta:     DesignMeta
}

// ─────────────────────────────────────────────────────────────────────────
// Arrays runtime (pra validator + UI usar)
// ─────────────────────────────────────────────────────────────────────────

export const THEME_MODES_V3:        readonly ThemeMode[]   = ['dark', 'light']
export { FONT_PAIRS_V3 } from './storefront-design-v3.font-pairs'
export const RADII_V3:              readonly Radius[]      = ['none', 'sm', 'md', 'lg', 'full']
export const DENSITIES_V3:          readonly Density[]     = ['compact', 'cozy', 'spacious']
export const BUTTON_STYLES_V3:      readonly ButtonStyleKind[] = ['solid', 'outline', 'pill', 'sharp']
export const BUTTON_WEIGHTS_V3:     readonly ButtonWeight[]    = ['normal', 'bold']
export const BACKGROUND_KINDS_V3:   readonly BackgroundKind[]  = ['none', 'color', 'image', 'video', 'gradient']
export const BLOCK_TYPES_V3:        readonly BlockType[]   = [
  'heading','subheading','paragraph','image','video','button','badge','countdown',
  'divider','spacer','icon','productCardMini','collectionLink','socialIcon','slide',
]
export const SECTION_TYPES_V3:      readonly SectionType[] = [
  'siteHeader','siteFooter','announcementBar','breadcrumb',
  'hero','slider','imageBanner','imageHotspot','imageWithText','marquee',
  'productGrid','productCarousel','featuredProduct','collectionGrid','productDetailLayout','productKits',
  'richText','testimonials','logoList','faq','newsletter','videoBlock','customHtml',
  'cartLayout','checkoutLayout','whatsappCatalog',
  'leadForm',
  'roomVisualizer',
]
export const PAGE_KEYS_V3:          readonly (keyof PageMap)[] = ['home','product','collection','cart','checkout']
