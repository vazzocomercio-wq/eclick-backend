import type {
  StorefrontDesign, DesignTheme, DesignColors, DesignEffects,
  ProductPageDesign, Section, SectionType,
} from './storefront-design.types'
import { THEME_MODES, FONT_PAIRS, RADII, DENSITIES } from './storefront-design.types'
import { DEFAULT_DESIGN } from './storefront-design.templates'

/**
 * Validador runtime da receita de design.
 *
 * A IA pode devolver JSON levemente fora do esquema. Este validador NUNCA
 * lanca: corrige/clampa cada campo e preenche o que faltou a partir de um
 * design de fallback (o modelo de inspiracao ou o padrao). Garante que o
 * resultado e sempre renderavel pelo frontend.
 *
 * Trata os dois esquemas: v1 (secoes simples) e v2 (Tema Premium).
 */

const HEX = /^#[0-9a-fA-F]{6}$/

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, fallback: string, max: number): string {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, max)
  return fallback
}

/** Como str, mas devolve undefined quando ausente — pra campos opcionais. */
function optStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

function hex(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : fallback
}

function optHex(v: unknown, fallback: string | undefined): string | undefined {
  if (typeof v === 'string' && HEX.test(v.trim())) return v.trim()
  return fallback
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.round(v) : NaN
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

// ── tema ──────────────────────────────────────────────────────────────

function validateColors(raw: unknown, fb: DesignColors): DesignColors {
  const o = isObj(raw) ? raw : {}
  const c: DesignColors = {
    background: hex(o.background, fb.background),
    surface:    hex(o.surface,    fb.surface),
    primary:    hex(o.primary,    fb.primary),
    text:       hex(o.text,       fb.text),
    textMuted:  hex(o.textMuted,  fb.textMuted),
    border:     hex(o.border,     fb.border),
  }
  const dark      = optHex(o.dark,      fb.dark)
  const watermark = optHex(o.watermark, fb.watermark)
  const onAccent  = optHex(o.onAccent,  fb.onAccent)
  if (dark)      c.dark = dark
  if (watermark) c.watermark = watermark
  if (onAccent)  c.onAccent = onAccent
  return c
}

function validateEffects(raw: unknown): DesignEffects | undefined {
  if (!isObj(raw)) return undefined
  return {
    scrollReveal:  bool(raw.scrollReveal, true),
    watermarks:    bool(raw.watermarks, true),
    parallaxTilt:  bool(raw.parallaxTilt, true),
    hoverRollover: bool(raw.hoverRollover, true),
  }
}

function validateTheme(raw: unknown, fb: DesignTheme): DesignTheme {
  const o = isObj(raw) ? raw : {}
  const t: DesignTheme = {
    mode:     oneOf(o.mode, THEME_MODES, fb.mode),
    colors:   validateColors(o.colors, fb.colors),
    fontPair: oneOf(o.fontPair, FONT_PAIRS, fb.fontPair),
    radius:   oneOf(o.radius, RADII, fb.radius),
    density:  oneOf(o.density, DENSITIES, fb.density),
  }
  const effects = validateEffects(o.effects) ?? fb.effects
  if (effects) t.effects = effects
  return t
}

// ── sub-estruturas de secoes ──────────────────────────────────────────

function validateNav(raw: unknown): Array<{ label: string; href: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isObj)
    .map(o => ({ label: str(o.label, '', 40), href: str(o.href, '#', 300) }))
    .filter(n => n.label)
    .slice(0, 8)
}

function validateSlides(raw: unknown): Array<{ imageUrl: string; label?: string; href?: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isObj)
    .map(o => ({
      imageUrl: str(o.imageUrl, '', 600),
      label:    optStr(o.label, 60),
      href:     optStr(o.href, 300),
    }))
    .slice(0, 10)
}

function validateHotspots(
  raw: unknown,
): Array<{ xPct: number; yPct: number; productId?: string; label?: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isObj)
    .map(o => ({
      xPct:      num(o.xPct, 50, 0, 100),
      yPct:      num(o.yPct, 50, 0, 100),
      productId: optStr(o.productId, 80),
      label:     optStr(o.label, 60),
    }))
    .slice(0, 12)
}

function validateCategories(
  raw: unknown,
): Array<{ label: string; imageUrl: string; href?: string; count?: number }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isObj)
    .map(o => ({
      label:    str(o.label, '', 60),
      imageUrl: str(o.imageUrl, '', 600),
      href:     optStr(o.href, 300),
      count:    typeof o.count === 'number' && Number.isFinite(o.count)
        ? Math.max(0, Math.round(o.count))
        : undefined,
    }))
    .filter(c => c.label)
    .slice(0, 12)
}

function validateStrArr(raw: unknown, maxItems: number, maxLen: number, fb: string[]): string[] {
  if (!Array.isArray(raw)) return fb
  const arr = raw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim().slice(0, maxLen))
    .slice(0, maxItems)
  return arr.length ? arr : fb
}

function validateFooterColumns(
  raw: unknown,
): Array<{ title: string; links: Array<{ label: string; href: string }> }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const cols = raw
    .filter(isObj)
    .map(o => ({ title: str(o.title, '', 60), links: validateNav(o.links) }))
    .filter(c => c.title)
    .slice(0, 5)
  return cols.length ? cols : undefined
}

function validateColumnsOpt(
  raw: unknown,
): { mobile: number; tablet: number; desktop: number } | undefined {
  if (!isObj(raw)) return undefined
  return {
    mobile:  int(raw.mobile, 2, 1, 2),
    tablet:  int(raw.tablet, 3, 1, 4),
    desktop: int(raw.desktop, 4, 2, 5),
  }
}

// ── secoes ────────────────────────────────────────────────────────────

function validateSection(raw: unknown): Section | null {
  if (!isObj(raw)) return null
  switch (raw.type) {
    // ── v1 ──────────────────────────────────────────────────────────
    case 'header':
      return { type: 'header', variant: oneOf(raw.variant, ['minimal', 'centered', 'overlay'] as const, 'minimal') }
    case 'hero':
      return {
        type: 'hero',
        variant:     oneOf(raw.variant, ['gradient', 'image', 'split'] as const, 'gradient'),
        headline:    str(raw.headline, 'Bem-vindo à loja', 120),
        subheadline: str(raw.subheadline, 'Conheça nossos produtos.', 240),
        ctaLabel:    str(raw.ctaLabel, 'Ver produtos', 40),
        imageUrl:    typeof raw.imageUrl === 'string' ? raw.imageUrl : null,
      }
    case 'collections':
      return {
        type: 'collections',
        variant: oneOf(raw.variant, ['strip', 'grid'] as const, 'strip'),
        title:   str(raw.title, 'Coleções', 80),
      }
    case 'productGrid': {
      const cols = isObj(raw.columns) ? raw.columns : {}
      return {
        type: 'productGrid',
        variant: oneOf(raw.variant, ['compact', 'elevated', 'editorial'] as const, 'elevated'),
        title:   str(raw.title, 'Produtos', 80),
        columns: {
          mobile:  int(cols.mobile, 2, 1, 2),
          tablet:  int(cols.tablet, 3, 1, 4),
          desktop: int(cols.desktop, 4, 2, 4),
        },
      }
    }
    case 'about':
      return {
        type: 'about',
        variant: oneOf(raw.variant, ['simple', 'banner'] as const, 'simple'),
        title:   str(raw.title, 'Sobre a loja', 80),
        body:    str(raw.body, 'Conheça mais sobre a nossa loja.', 600),
      }
    case 'footer':
      return { type: 'footer', variant: oneOf(raw.variant, ['minimal', 'full'] as const, 'minimal') }

    // ── v2 premium ──────────────────────────────────────────────────
    case 'announcementBar':
      return {
        type: 'announcementBar',
        message:     str(raw.message, 'Frete grátis nas compras acima de R$ 199', 160),
        ctaLabel:    optStr(raw.ctaLabel, 40),
        ctaHref:     optStr(raw.ctaHref, 300),
        countdownTo: typeof raw.countdownTo === 'string' ? raw.countdownTo : null,
      }
    case 'siteHeader':
      return {
        type: 'siteHeader',
        variant:    oneOf(raw.variant, ['centered', 'split'] as const, 'split'),
        sticky:     bool(raw.sticky, true),
        showSearch: bool(raw.showSearch, true),
        showCart:   bool(raw.showCart, true),
        nav:        validateNav(raw.nav),
      }
    case 'heroPortrait':
      return {
        type: 'heroPortrait',
        watermark:   optStr(raw.watermark, 40),
        headline:    str(raw.headline, 'Nova coleção', 120),
        subheadline: optStr(raw.subheadline, 240),
        ctaLabel:    optStr(raw.ctaLabel, 40),
        slides:      validateSlides(raw.slides),
      }
    case 'productShowcase': {
      const productIds = Array.isArray(raw.productIds)
        ? raw.productIds.filter((x): x is string => typeof x === 'string').slice(0, 50)
        : undefined
      return {
        type: 'productShowcase',
        layout:       oneOf(raw.layout, ['carousel', 'grid'] as const, 'carousel'),
        title:        str(raw.title, 'Produtos', 80),
        watermark:    optStr(raw.watermark, 40),
        source:       oneOf(raw.source, ['storefront', 'collection', 'manual'] as const, 'storefront'),
        collectionId: typeof raw.collectionId === 'string' ? raw.collectionId : null,
        productIds,
        columns:      validateColumnsOpt(raw.columns),
      }
    }
    case 'imageHotspot':
      return {
        type: 'imageHotspot',
        title:    optStr(raw.title, 80),
        imageUrl: str(raw.imageUrl, '', 600),
        hotspots: validateHotspots(raw.hotspots),
      }
    case 'categoryGrid':
      return {
        type: 'categoryGrid',
        title:      str(raw.title, 'Categorias', 80),
        watermark:  optStr(raw.watermark, 40),
        categories: validateCategories(raw.categories),
      }
    case 'tiltBanner':
      return {
        type: 'tiltBanner',
        imageUrl:  str(raw.imageUrl, '', 600),
        watermark: optStr(raw.watermark, 40),
        headline:  optStr(raw.headline, 120),
      }
    case 'fullBanner':
      return {
        type: 'fullBanner',
        imageUrl:    str(raw.imageUrl, '', 600),
        headline:    str(raw.headline, 'Destaque da semana', 120),
        subheadline: optStr(raw.subheadline, 240),
        ctaLabel:    optStr(raw.ctaLabel, 40),
        ctaHref:     optStr(raw.ctaHref, 300),
      }
    case 'marquee':
      return {
        type: 'marquee',
        items: validateStrArr(raw.items, 12, 60, ['Novidades toda semana']),
      }
    case 'editorialSplit':
      return {
        type: 'editorialSplit',
        title:     str(raw.title, 'Nossa história', 120),
        body:      str(raw.body, 'Conheça mais sobre a nossa loja.', 800),
        imageUrl:  str(raw.imageUrl, '', 600),
        imageSide: oneOf(raw.imageSide, ['left', 'right'] as const, 'right'),
        ctaLabel:  optStr(raw.ctaLabel, 40),
        ctaHref:   optStr(raw.ctaHref, 300),
      }
    case 'siteFooter':
      return {
        type: 'siteFooter',
        variant:    oneOf(raw.variant, ['minimal', 'columns'] as const, 'columns'),
        columns:    validateFooterColumns(raw.columns),
        newsletter: typeof raw.newsletter === 'boolean' ? raw.newsletter : undefined,
      }

    default:
      return null
  }
}

const HEADER_TYPES:  readonly SectionType[] = ['header', 'siteHeader']
const FOOTER_TYPES:  readonly SectionType[] = ['footer', 'siteFooter']
const PRODUCT_TYPES: readonly SectionType[] = ['productGrid', 'productShowcase']

function hasType(s: Section, types: readonly SectionType[]): boolean {
  return (types as readonly string[]).includes(s.type)
}

function validateSections(raw: unknown, fb: Section[], version: 1 | 2): Section[] {
  const arr = Array.isArray(raw) ? raw : []
  const sections = arr
    .map(validateSection)
    .filter((s): s is Section => s !== null)

  // Garante os blocos essenciais — uma loja sem cabecalho, grade de
  // produtos ou rodape nao faz sentido. v2 usa as variantes premium.
  if (!sections.some(s => hasType(s, HEADER_TYPES))) {
    sections.unshift(
      version === 2
        ? { type: 'siteHeader', variant: 'split', sticky: true, showSearch: true, showCart: true, nav: [] }
        : { type: 'header', variant: 'minimal' },
    )
  }
  if (!sections.some(s => hasType(s, PRODUCT_TYPES))) {
    if (version === 2) {
      sections.push({
        type: 'productShowcase', layout: 'carousel', title: 'Produtos',
        source: 'storefront', collectionId: null,
      })
    } else {
      const fbGrid = fb.find(s => s.type === 'productGrid')
      sections.push(fbGrid ?? {
        type: 'productGrid', variant: 'elevated', title: 'Produtos',
        columns: { mobile: 2, tablet: 3, desktop: 4 },
      })
    }
  }
  if (!sections.some(s => hasType(s, FOOTER_TYPES))) {
    sections.push(
      version === 2
        ? { type: 'siteFooter', variant: 'columns', newsletter: true }
        : { type: 'footer', variant: 'minimal' },
    )
  }

  // Ordem final: announcementBar -> cabecalho -> meio -> rodape.
  const announce = sections.find(s => s.type === 'announcementBar')
  const header   = sections.find(s => hasType(s, HEADER_TYPES))
  const footers  = sections.filter(s => hasType(s, FOOTER_TYPES))
  const footer   = footers[footers.length - 1]
  const middle   = sections.filter(s =>
    s !== announce && s !== header && s !== footer &&
    s.type !== 'announcementBar' &&
    !hasType(s, HEADER_TYPES) &&
    !hasType(s, FOOTER_TYPES),
  )
  return [announce, header, ...middle, footer].filter((s): s is Section => s != null)
}

function validateProduct(raw: unknown, fb: ProductPageDesign): ProductPageDesign {
  const o = isObj(raw) ? raw : {}
  return {
    gallery:        oneOf(o.gallery, ['side', 'top'] as const, fb.gallery),
    showAttributes: typeof o.showAttributes === 'boolean' ? o.showAttributes : fb.showAttributes,
    ctaMode:        oneOf(o.ctaMode, ['whatsapp', 'cart'] as const, fb.ctaMode),
  }
}

/** Valida e normaliza um design vindo da IA (ou do frontend). Nunca lanca. */
export function validateDesign(
  raw: unknown,
  fallback: StorefrontDesign = DEFAULT_DESIGN,
): StorefrontDesign {
  const o = isObj(raw) ? raw : {}
  const version: 1 | 2 = o.version === 2 ? 2 : 1
  return {
    version,
    theme:    validateTheme(o.theme, fallback.theme),
    sections: validateSections(o.sections, fallback.sections, version),
    product:  validateProduct(o.product, fallback.product),
  }
}
