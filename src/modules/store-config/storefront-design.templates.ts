import type { StorefrontDesign } from './storefront-design.types'

/**
 * Modelos de inspiracao da Loja Propria (backend).
 *
 * ESPELHO de eclick-frontend/src/lib/storefront/templates.ts — manter em
 * sync. O backend usa estes modelos como ponto de partida da geracao por
 * IA e como base do validador (preenche campos que a IA deixou de fora).
 */

const boutiqueElegante: StorefrontDesign = {
  version: 1,
  theme: {
    mode: 'dark',
    colors: {
      background: '#0e0c0a', surface: '#17130f', primary: '#c9a24b',
      text: '#f5efe6', textMuted: '#9c9081', border: '#2a2218',
    },
    fontPair: 'elegant', radius: 'sm', density: 'spacious',
  },
  sections: [
    { type: 'header', variant: 'centered' },
    {
      type: 'hero', variant: 'gradient',
      headline: 'Peças que contam histórias',
      subheadline: 'Curadoria exclusiva, feita pra durar.',
      ctaLabel: 'Ver coleção',
    },
    { type: 'productGrid', variant: 'elevated', title: 'Destaques', columns: { mobile: 2, tablet: 2, desktop: 3 } },
    {
      type: 'about', variant: 'simple', title: 'Sobre a casa',
      body: 'Cada peça é escolhida a dedo, pensando em quem valoriza qualidade e atemporalidade.',
    },
    { type: 'footer', variant: 'full' },
  ],
  product: { gallery: 'side', showAttributes: true, ctaMode: 'whatsapp' },
}

const vibrante: StorefrontDesign = {
  version: 1,
  theme: {
    mode: 'light',
    colors: {
      background: '#ffffff', surface: '#f6f6f8', primary: '#ff3d71',
      text: '#16131a', textMuted: '#6b6675', border: '#e6e4ea',
    },
    fontPair: 'bold', radius: 'lg', density: 'cozy',
  },
  sections: [
    { type: 'header', variant: 'minimal' },
    {
      type: 'hero', variant: 'split',
      headline: 'Novidades toda semana',
      subheadline: 'Estilo que acompanha o seu ritmo.',
      ctaLabel: 'Comprar agora',
    },
    { type: 'productGrid', variant: 'compact', title: 'Mais vendidos', columns: { mobile: 2, tablet: 3, desktop: 4 } },
    { type: 'footer', variant: 'minimal' },
  ],
  product: { gallery: 'top', showAttributes: false, ctaMode: 'whatsapp' },
}

const techMinimalista: StorefrontDesign = {
  version: 1,
  theme: {
    mode: 'dark',
    colors: {
      background: '#09090b', surface: '#111114', primary: '#00E5FF',
      text: '#fafafa', textMuted: '#a1a1aa', border: '#26262c',
    },
    fontPair: 'modern', radius: 'md', density: 'cozy',
  },
  sections: [
    { type: 'header', variant: 'minimal' },
    {
      type: 'hero', variant: 'gradient',
      headline: 'Tecnologia que resolve',
      subheadline: 'Os produtos certos, sem enrolação.',
      ctaLabel: 'Explorar catálogo',
    },
    { type: 'productGrid', variant: 'editorial', title: 'Catálogo', columns: { mobile: 1, tablet: 2, desktop: 3 } },
    {
      type: 'about', variant: 'banner', title: 'Por que comprar aqui',
      body: 'Entrega rápida, garantia real e suporte de verdade em cada compra.',
    },
    { type: 'footer', variant: 'full' },
  ],
  product: { gallery: 'side', showAttributes: true, ctaMode: 'whatsapp' },
}

const cleanClaro: StorefrontDesign = {
  version: 1,
  theme: {
    mode: 'light',
    colors: {
      background: '#fbfbfa', surface: '#ffffff', primary: '#1f6feb',
      text: '#1a1a1a', textMuted: '#75757d', border: '#e8e8e6',
    },
    fontPair: 'modern', radius: 'md', density: 'spacious',
  },
  sections: [
    { type: 'header', variant: 'minimal' },
    {
      type: 'hero', variant: 'gradient',
      headline: 'Tudo o que você precisa',
      subheadline: 'Simples, claro e direto ao ponto.',
      ctaLabel: 'Ver produtos',
    },
    { type: 'productGrid', variant: 'elevated', title: 'Produtos', columns: { mobile: 2, tablet: 3, desktop: 4 } },
    { type: 'footer', variant: 'minimal' },
  ],
  product: { gallery: 'top', showAttributes: true, ctaMode: 'whatsapp' },
}

export const STOREFRONT_TEMPLATE_MAP: Record<string, StorefrontDesign> = {
  tech_minimalista:  techMinimalista,
  boutique_elegante: boutiqueElegante,
  vibrante,
  clean_claro:       cleanClaro,
}

/** Receita usada como base de fallback do validador. */
export const DEFAULT_DESIGN: StorefrontDesign = techMinimalista
