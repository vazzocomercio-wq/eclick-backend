import type { StorefrontDesign } from './storefront-design.types'

/**
 * Modelo de inspiracao da Loja Propria (backend).
 *
 * ESPELHO de eclick-frontend/src/lib/storefront/templates.ts — manter em
 * sync. O backend usa este modelo como ponto de partida da geracao por
 * IA e como base do validador (preenche campos que a IA deixou de fora).
 */

const editorialPremium: StorefrontDesign = {
  version: 2,
  theme: {
    mode: 'light',
    colors: {
      background: '#f4f1ec', surface: '#ffffff', primary: '#1c1b19',
      text: '#1c1b19', textMuted: '#7a756c', border: '#e3ddd2',
      dark: '#1c1b19', watermark: '#ece7dd', onAccent: '#f4f1ec',
    },
    fontPair: 'editorial', radius: 'sm', density: 'spacious',
    effects: { scrollReveal: true, watermarks: true, parallaxTilt: true, hoverRollover: true },
  },
  sections: [
    {
      type: 'announcementBar',
      message: 'Frete grátis acima de R$ 199 — entregamos para todo o Brasil',
      countdownTo: null,
    },
    {
      type: 'siteHeader', variant: 'split',
      sticky: true, showSearch: true, showCart: true,
      nav: [
        { label: 'Início', href: '/' },
        { label: 'Novidades', href: '#novidades' },
        { label: 'Coleções', href: '#colecoes' },
        { label: 'Sobre', href: '#sobre' },
      ],
    },
    {
      type: 'heroPortrait',
      watermark: 'LOJA',
      headline: 'Curadoria que transforma o seu dia a dia',
      subheadline: 'Peças escolhidas uma a uma — design, qualidade e história em cada detalhe.',
      ctaLabel: 'Explorar a coleção',
      slides: [
        { imageUrl: '', label: 'Lançamentos' },
        { imageUrl: '', label: 'Mais desejados' },
        { imageUrl: '', label: 'Edição limitada' },
      ],
    },
    {
      type: 'marquee',
      items: ['Novidades toda semana', 'Curadoria exclusiva', 'Entrega para todo o Brasil', 'Atendimento de verdade'],
    },
    {
      type: 'productShowcase', layout: 'carousel',
      title: 'Em alta', watermark: 'EM ALTA',
      source: 'storefront', collectionId: null,
    },
    {
      type: 'categoryGrid',
      title: 'Navegue por categoria', watermark: 'CATEGORIAS',
      categories: [
        { label: 'Destaques', imageUrl: '' },
        { label: 'Novidades', imageUrl: '' },
        { label: 'Mais vendidos', imageUrl: '' },
        { label: 'Ofertas', imageUrl: '' },
      ],
    },
    {
      type: 'editorialSplit',
      title: 'Feito para durar',
      body: 'Cada produto da nossa loja passa por uma curadoria cuidadosa. Acreditamos em qualidade que se vê e se sente — e em um atendimento que acompanha você do clique à entrega.',
      imageUrl: '', imageSide: 'right',
      ctaLabel: 'Conheça a loja', ctaHref: '#sobre',
    },
    {
      type: 'productShowcase', layout: 'grid',
      title: 'Catálogo completo',
      source: 'storefront', collectionId: null,
      columns: { mobile: 2, tablet: 3, desktop: 4 },
    },
    {
      type: 'siteFooter', variant: 'columns', newsletter: true,
      columns: [
        {
          title: 'Loja',
          links: [
            { label: 'Novidades', href: '#novidades' },
            { label: 'Mais vendidos', href: '#' },
            { label: 'Ofertas', href: '#' },
          ],
        },
        {
          title: 'Ajuda',
          links: [
            { label: 'Trocas e devoluções', href: '#' },
            { label: 'Entrega', href: '#' },
            { label: 'Fale conosco', href: '#' },
          ],
        },
      ],
    },
  ],
  product: { gallery: 'side', showAttributes: true, ctaMode: 'whatsapp' },
}

/** Espelha as variantes do frontend (`STOREFRONT_TEMPLATES` em
 *  lib/storefront/templates.ts) — reusa a estrutura editorialPremium
 *  trocando apenas o tema. Permite que `inspirationId` cubra as 4
 *  opcoes que aparecem na galeria do designer. */
function variant(
  overrides: Partial<StorefrontDesign['theme']> & { colors?: Partial<StorefrontDesign['theme']['colors']> },
): StorefrontDesign {
  return {
    ...editorialPremium,
    theme: {
      ...editorialPremium.theme,
      ...overrides,
      colors: { ...editorialPremium.theme.colors, ...(overrides.colors ?? {}) },
    },
  }
}

const editorialDark: StorefrontDesign = variant({
  mode: 'dark',
  colors: {
    background: '#0c0c0e', surface: '#16161a', primary: '#e9c46a',
    text: '#fafafa', textMuted: '#a8a29e', border: '#27272a',
    dark: '#000000', watermark: '#1a1a1e', onAccent: '#0c0c0e',
  },
  fontPair: 'editorial', radius: 'sm', density: 'spacious',
})

const boutiqueWarm: StorefrontDesign = variant({
  mode: 'light',
  colors: {
    background: '#fbf6ee', surface: '#ffffff', primary: '#a0522d',
    text: '#3d2e22', textMuted: '#9a8675', border: '#ecdcc2',
    dark: '#3d2e22', watermark: '#f3e9d6', onAccent: '#fbf6ee',
  },
  fontPair: 'classic', radius: 'md', density: 'spacious',
})

const vibrantPop: StorefrontDesign = variant({
  mode: 'light',
  colors: {
    background: '#fff7f1', surface: '#ffffff', primary: '#ff3366',
    text: '#1a1a2e', textMuted: '#6c6c80', border: '#ffd9c7',
    dark: '#1a1a2e', watermark: '#ffe2d0', onAccent: '#ffffff',
  },
  fontPair: 'bold', radius: 'lg', density: 'cozy',
})

export const STOREFRONT_TEMPLATE_MAP: Record<string, StorefrontDesign> = {
  editorial_premium: editorialPremium,
  editorial_dark:    editorialDark,
  boutique_warm:     boutiqueWarm,
  vibrant_pop:       vibrantPop,
}

/** Receita usada como base de fallback do validador e da geracao por IA. */
export const DEFAULT_DESIGN: StorefrontDesign = editorialPremium
