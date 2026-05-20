/**
 * Validador runtime da receita de design v3 (Store Builder).
 *
 * NUNCA lanca. Recebe JSON arbitrario (vindo da IA, do editor ou do banco),
 * sanitiza/clampa cada campo e preenche o que faltou a partir de um design
 * de fallback (template de inspiracao ou DEFAULT_DESIGN_V3). Garante que o
 * resultado e sempre renderavel pelo frontend.
 *
 * Estrategia:
 *  - Theme: validacao completa (cores hex, enums, customFonts opcional).
 *  - Globals (header/footer): validacao basica das settings principais.
 *  - Pages: cada pagina passa por validatePage, que itera sections.
 *  - Sections: discriminator por type — settings invalidas viram defaults
 *    minimos (passthrough leniente; nao queremos perder design por causa
 *    de 1 campo errado).
 *  - Blocks: passthrough com checagem de type + id. Settings ficam livres
 *    (o renderer trata gracefully campo faltante por bloco).
 */

import type {
  StorefrontDesignV3, ThemeV3, DesignColorsV3, DesignEffects, ThemeButtons,
  PageDesign, PageMap, Section, SectionType, Block, BlockType, BackgroundStyle,
  Spacing, Visibility, DesignGlobals, SiteHeaderSection, SiteFooterSection,
  ProductSource,
} from './storefront-design-v3.types'
import {
  THEME_MODES_V3, FONT_PAIRS_V3, RADII_V3, DENSITIES_V3,
  BUTTON_STYLES_V3, BUTTON_WEIGHTS_V3, BACKGROUND_KINDS_V3,
  BLOCK_TYPES_V3, SECTION_TYPES_V3, PAGE_KEYS_V3,
} from './storefront-design-v3.types'
import { DEFAULT_DESIGN_V3 } from './storefront-design-v3.templates'

const HEX = /^#[0-9a-fA-F]{6}$/

// ─────────────────────────────────────────────────────────────────────────
// Primitivos
// ─────────────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isArr(v: unknown): v is unknown[] { return Array.isArray(v) }

function str(v: unknown, fallback: string, max = 5000): string {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, max)
  return fallback
}
function optStr(v: unknown, max = 5000): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}
function hex(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : fallback
}
function optHex(v: unknown, fb: string | undefined): string | undefined {
  if (typeof v === 'string' && HEX.test(v.trim())) return v.trim()
  return fb
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
function uuidOrFallback(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : fallback
}

// ─────────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────────

function validateColors(raw: unknown, fb: DesignColorsV3): DesignColorsV3 {
  const r = isObj(raw) ? raw : {}
  return {
    background: hex(r.background, fb.background),
    surface:    hex(r.surface,    fb.surface),
    primary:    hex(r.primary,    fb.primary),
    text:       hex(r.text,       fb.text),
    textMuted:  hex(r.textMuted,  fb.textMuted),
    border:     hex(r.border,     fb.border),
    dark:       optHex(r.dark,      fb.dark),
    watermark:  optHex(r.watermark, fb.watermark),
    onAccent:   optHex(r.onAccent,  fb.onAccent),
    success:    optHex(r.success,   fb.success),
    error:      optHex(r.error,     fb.error),
    warning:    optHex(r.warning,   fb.warning),
  }
}

function validateEffects(raw: unknown, fb: DesignEffects): DesignEffects {
  const r = isObj(raw) ? raw : {}
  return {
    scrollReveal:  bool(r.scrollReveal,  fb.scrollReveal),
    watermarks:    bool(r.watermarks,    fb.watermarks),
    parallaxTilt:  bool(r.parallaxTilt,  fb.parallaxTilt),
    hoverRollover: bool(r.hoverRollover, fb.hoverRollover),
  }
}

function validateButtons(raw: unknown, fb: ThemeButtons): ThemeButtons {
  const r = isObj(raw) ? raw : {}
  return {
    style:  oneOf(r.style,  BUTTON_STYLES_V3, fb.style),
    weight: oneOf(r.weight, BUTTON_WEIGHTS_V3, fb.weight),
  }
}

function validateTheme(raw: unknown, fb: ThemeV3): ThemeV3 {
  const r = isObj(raw) ? raw : {}
  const cf = isObj(r.customFonts) ? r.customFonts : undefined
  return {
    mode:     oneOf(r.mode,     THEME_MODES_V3, fb.mode),
    colors:   validateColors(r.colors, fb.colors),
    fontPair: oneOf(r.fontPair, FONT_PAIRS_V3, fb.fontPair),
    customFonts: cf ? {
      heading:        optStr(cf.heading, 200),
      body:           optStr(cf.body,    200),
      googleFamilies: isArr(cf.googleFamilies)
        ? cf.googleFamilies.filter((x): x is string => typeof x === 'string').slice(0, 20)
        : undefined,
    } : fb.customFonts,
    radius:   oneOf(r.radius,   RADII_V3, fb.radius),
    density:  oneOf(r.density,  DENSITIES_V3, fb.density),
    effects:  validateEffects(r.effects, fb.effects),
    buttons:  validateButtons(r.buttons, fb.buttons),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Spacing / Background / Visibility
// ─────────────────────────────────────────────────────────────────────────

function validateSpacing(raw: unknown, fb: Spacing): Spacing {
  const r = isObj(raw) ? raw : {}
  return {
    paddingTop:    int(r.paddingTop,    fb.paddingTop,    0, 400),
    paddingBottom: int(r.paddingBottom, fb.paddingBottom, 0, 400),
    marginTop:     int(r.marginTop,     fb.marginTop,     0, 400),
    marginBottom:  int(r.marginBottom,  fb.marginBottom,  0, 400),
  }
}

function validateBackground(raw: unknown, fb: BackgroundStyle): BackgroundStyle {
  const r = isObj(raw) ? raw : {}
  const kind = oneOf(r.kind, BACKGROUND_KINDS_V3, fb.kind)
  const out: BackgroundStyle = { kind }
  if (kind === 'color')    out.color = hex(r.color, fb.color ?? '#ffffff')
  if (kind === 'image') {
    out.imageUrl   = str(r.imageUrl, fb.imageUrl ?? '')
    out.imageFocus = oneOf(r.imageFocus, ['center','top','bottom','left','right'] as const, fb.imageFocus ?? 'center')
  }
  if (kind === 'video') out.videoUrl = str(r.videoUrl, fb.videoUrl ?? '')
  if (kind === 'gradient') {
    const g = isObj(r.gradient) ? r.gradient : (fb.gradient ?? {})
    out.gradient = {
      from:  hex((g as any).from,  '#000000'),
      to:    hex((g as any).to,    '#ffffff'),
      angle: int((g as any).angle, 180, 0, 360),
    }
  }
  out.overlayColor   = optHex(r.overlayColor, fb.overlayColor)
  out.overlayOpacity = typeof r.overlayOpacity === 'number'
    ? num(r.overlayOpacity, fb.overlayOpacity ?? 0, 0, 1)
    : fb.overlayOpacity
  return out
}

function validateVisibility(raw: unknown): Visibility {
  const r = isObj(raw) ? raw : {}
  return { desktop: bool(r.desktop, true), mobile: bool(r.mobile, true) }
}

// ─────────────────────────────────────────────────────────────────────────
// Blocks (passthrough leniente — confia no editor)
// ─────────────────────────────────────────────────────────────────────────

function validateBlock(raw: unknown, fallbackId: string): Block | null {
  if (!isObj(raw)) return null
  const type = oneOf(raw.type, BLOCK_TYPES_V3, 'paragraph' as BlockType)
  const id   = uuidOrFallback(raw.id, fallbackId)
  const settings = isObj(raw.settings) ? raw.settings : {}
  const mobileOverrides = isObj(raw.mobileOverrides) ? raw.mobileOverrides : undefined
  // Passthrough: confiamos no editor/IA pra settings. Renderer trata campo faltante.
  return { id, type, settings, mobileOverrides } as Block
}

function validateBlocks(raw: unknown, sectionId: string): Block[] {
  if (!isArr(raw)) return []
  return raw
    .map((b, i) => validateBlock(b, `${sectionId}_b${i + 1}`))
    .filter((b): b is Block => b !== null)
    .slice(0, 100)
}

// ─────────────────────────────────────────────────────────────────────────
// Sections (estrutura comum + settings leniente)
// ─────────────────────────────────────────────────────────────────────────

function validateSection(raw: unknown, fallbackId: string): Section | null {
  if (!isObj(raw)) return null
  const type = raw.type
  if (typeof type !== 'string' || !(SECTION_TYPES_V3 as readonly string[]).includes(type)) {
    return null
  }
  const id = uuidOrFallback(raw.id, fallbackId)
  const settings = isObj(raw.settings) ? raw.settings : {}
  const blocks = validateBlocks(raw.blocks, id)
  const visibility = validateVisibility(raw.visibility)
  const spacing = validateSpacing(raw.spacing, {
    paddingTop: 80, paddingBottom: 80, marginTop: 0, marginBottom: 0,
  })
  const background = validateBackground(raw.background, { kind: 'none' })
  const mob = isObj(raw.mobileOverrides) ? raw.mobileOverrides : undefined
  const mobileOverrides = mob ? {
    settings:   isObj(mob.settings)   ? mob.settings   : undefined,
    spacing:    isObj(mob.spacing)    ? mob.spacing    : undefined,
    background: isObj(mob.background) ? mob.background : undefined,
  } : undefined
  return { id, type, settings, blocks, visibility, spacing, background, mobileOverrides } as Section
}

function validateSections(raw: unknown, prefix: string): Section[] {
  if (!isArr(raw)) return []
  return raw
    .map((s, i) => validateSection(s, `${prefix}_${String(i + 1).padStart(3, '0')}`))
    .filter((s): s is Section => s !== null)
    .slice(0, 30)
}

// ─────────────────────────────────────────────────────────────────────────
// Globals (header obrigatorio siteHeader, footer obrigatorio siteFooter)
// ─────────────────────────────────────────────────────────────────────────

function ensureSiteHeader(raw: unknown, fb: SiteHeaderSection): SiteHeaderSection {
  const v = validateSection(raw, 'global_header')
  if (v && v.type === 'siteHeader') return v as SiteHeaderSection
  return fb
}

function ensureSiteFooter(raw: unknown, fb: SiteFooterSection): SiteFooterSection {
  const v = validateSection(raw, 'global_footer')
  if (v && v.type === 'siteFooter') return v as SiteFooterSection
  return fb
}

function validateGlobals(raw: unknown, fb: DesignGlobals): DesignGlobals {
  const r = isObj(raw) ? raw : {}
  return {
    header: ensureSiteHeader(r.header, fb.header),
    footer: ensureSiteFooter(r.footer, fb.footer),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Pages
// ─────────────────────────────────────────────────────────────────────────

function validatePage(raw: unknown, fb: PageDesign, pageKey: string): PageDesign {
  const r = isObj(raw) ? raw : {}
  const sections = isArr(r.sections) && r.sections.length > 0
    ? validateSections(r.sections, pageKey)
    : fb.sections
  const seoRaw = isObj(r.seo) ? r.seo : {}
  return {
    sections,
    seo: {
      title:       optStr(seoRaw.title, 200),
      description: optStr(seoRaw.description, 500),
      ogImage:     optStr(seoRaw.ogImage, 500),
    },
    layout: oneOf(r.layout, ['default','sidebar','fullwidth'] as const, fb.layout ?? 'default'),
  }
}

function validatePages(raw: unknown, fb: PageMap): PageMap {
  const r = isObj(raw) ? raw : {}
  const out = {} as PageMap
  for (const k of PAGE_KEYS_V3) {
    out[k] = validatePage(r[k], fb[k], k)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────────

/**
 * Valida e normaliza um design v3 vindo de fonte arbitraria.
 *
 * @param raw         JSON cru (banco, IA, editor).
 * @param fallback    Design de inspiracao/fallback (default: DEFAULT_DESIGN_V3).
 */
export function validateDesignV3(
  raw: unknown,
  fallback: StorefrontDesignV3 = DEFAULT_DESIGN_V3,
): StorefrontDesignV3 {
  if (!isObj(raw)) return fallback
  return {
    version: 3,
    theme:   validateTheme(raw.theme, fallback.theme),
    globals: validateGlobals(raw.globals, fallback.globals),
    pages:   validatePages(raw.pages, fallback.pages),
    meta: {
      templateKey: str(
        isObj(raw.meta) ? (raw.meta as any).templateKey : undefined,
        fallback.meta.templateKey,
        100,
      ),
      updatedAt: new Date().toISOString(),
    },
  }
}
