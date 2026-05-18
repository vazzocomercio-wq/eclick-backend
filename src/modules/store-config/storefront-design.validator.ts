import type {
  StorefrontDesign, DesignTheme, DesignColors, ProductPageDesign, Section,
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
 */

const HEX = /^#[0-9a-fA-F]{6}$/

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, fallback: string, max: number): string {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, max)
  return fallback
}

function hex(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : fallback
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.round(v) : NaN
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function validateColors(raw: unknown, fb: DesignColors): DesignColors {
  const o = isObj(raw) ? raw : {}
  return {
    background: hex(o.background, fb.background),
    surface:    hex(o.surface,    fb.surface),
    primary:    hex(o.primary,    fb.primary),
    text:       hex(o.text,       fb.text),
    textMuted:  hex(o.textMuted,  fb.textMuted),
    border:     hex(o.border,     fb.border),
  }
}

function validateTheme(raw: unknown, fb: DesignTheme): DesignTheme {
  const o = isObj(raw) ? raw : {}
  return {
    mode:     oneOf(o.mode, THEME_MODES, fb.mode),
    colors:   validateColors(o.colors, fb.colors),
    fontPair: oneOf(o.fontPair, FONT_PAIRS, fb.fontPair),
    radius:   oneOf(o.radius, RADII, fb.radius),
    density:  oneOf(o.density, DENSITIES, fb.density),
  }
}

function validateSection(raw: unknown): Section | null {
  if (!isObj(raw)) return null
  switch (raw.type) {
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
    default:
      return null
  }
}

function validateSections(raw: unknown, fb: Section[]): Section[] {
  const arr = Array.isArray(raw) ? raw : []
  const sections = arr
    .map(validateSection)
    .filter((s): s is Section => s !== null)

  // Garante os blocos essenciais — uma loja sem grade de produtos ou sem
  // cabecalho/rodape nao faz sentido.
  if (!sections.some(s => s.type === 'header')) {
    sections.unshift({ type: 'header', variant: 'minimal' })
  }
  if (!sections.some(s => s.type === 'productGrid')) {
    const fbGrid = fb.find(s => s.type === 'productGrid')
    sections.push(fbGrid ?? {
      type: 'productGrid', variant: 'elevated', title: 'Produtos',
      columns: { mobile: 2, tablet: 3, desktop: 4 },
    })
  }
  if (!sections.some(s => s.type === 'footer')) {
    sections.push({ type: 'footer', variant: 'minimal' })
  }

  // Ordem final: header primeiro, footer ultimo, resto preservando a ordem.
  const header = sections.filter(s => s.type === 'header').slice(0, 1)
  const footer = sections.filter(s => s.type === 'footer').slice(-1)
  const middle = sections.filter(s => s.type !== 'header' && s.type !== 'footer')
  return [...header, ...middle, ...footer]
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
  return {
    version:  1,
    theme:    validateTheme(o.theme, fallback.theme),
    sections: validateSections(o.sections, fallback.sections),
    product:  validateProduct(o.product, fallback.product),
  }
}
