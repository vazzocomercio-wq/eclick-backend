/**
 * Templates v3 — 5 modelos iniciais do Store Builder.
 *
 * ESPELHO de eclick-frontend/src/lib/storefront/v3/templates.ts — manter
 * os dois em sync (mesmo padrao do margin.ts e do storefront-design v2).
 * Backend usa pra IA escolher template de inspiracao + fallback. Frontend
 * usa pro picker da galeria do Designer.
 *
 * IDs aqui sao deterministicos (`<tplKey>_<pageKey>_<idx>`) pra que o
 * arquivo seja diff-avel e revisavel. Quando o usuario clona um template
 * pra sua loja, o backend reescreve todos os IDs com crypto.randomUUID().
 */

import type {
  StorefrontDesignV3, ThemeV3, PageDesign,
  SiteHeaderSection, SiteFooterSection, AnnouncementBarSection,
  HeroSection, SliderSection, ImageBannerSection, ImageWithTextSection, MarqueeSection,
  ProductGridSection, ProductCarouselSection, FeaturedProductSection, CollectionGridSection,
  ProductDetailLayoutSection, CartLayoutSection, CheckoutLayoutSection,
  TestimonialsSection, NewsletterSection, BreadcrumbSection,
  Spacing, BackgroundStyle, Visibility, ProductSource,
} from './storefront-design-v3.types'

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const defaultVisibility = (): Visibility => ({ desktop: true, mobile: true })
const defaultSpacing    = (): Spacing => ({ paddingTop: 80, paddingBottom: 80, marginTop: 0, marginBottom: 0 })
const noSpacing         = (): Spacing => ({ paddingTop: 0,  paddingBottom: 0,  marginTop: 0, marginBottom: 0 })
const bgNone            = (): BackgroundStyle => ({ kind: 'none' })
const bgColor           = (color: string): BackgroundStyle => ({ kind: 'color', color })

const id = (tpl: string, page: string, n: number) => `${tpl}_${page}_${String(n).padStart(3, '0')}`
const bid = (sectionId: string, n: number) => `${sectionId}_b${n}`

// ─────────────────────────────────────────────────────────────────────────
// Globals factory (header + footer compartilhados entre paginas)
// ─────────────────────────────────────────────────────────────────────────

function makeHeader(tpl: string, opts: {
  variant?: 'centered' | 'split' | 'minimal'
  sticky?: boolean
  logoText?: string
  nav?: Array<{ label: string; href: string }>
}): SiteHeaderSection {
  return {
    id: `${tpl}_global_header`,
    type: 'siteHeader',
    settings: {
      variant:     opts.variant ?? 'split',
      sticky:      opts.sticky ?? true,
      showSearch:  true,
      showCart:    true,
      showAccount: true,
      logoText:    opts.logoText ?? 'Minha Loja',
      nav: opts.nav ?? [
        { label: 'Início',    href: '/' },
        { label: 'Novidades', href: '/produtos?ord=novos' },
        { label: 'Ofertas',   href: '/produtos?ord=promo' },
        { label: 'Sobre',     href: '/p/sobre' },
        { label: 'Contato',   href: '/p/contato' },
      ],
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    noSpacing(),
    background: bgNone(),
  }
}

function makeFooter(tpl: string, opts: {
  variant?: 'minimal' | 'columns'
  showNewsletter?: boolean
  copyright?: string
}): SiteFooterSection {
  return {
    id: `${tpl}_global_footer`,
    type: 'siteFooter',
    settings: {
      variant:            opts.variant ?? 'columns',
      showNewsletter:     opts.showNewsletter ?? true,
      showSocialIcons:    true,
      showPaymentMethods: true,
      copyright:          opts.copyright ?? `© ${new Date().getFullYear()} — Todos os direitos reservados`,
      columns: [
        {
          title: 'Loja',
          links: [
            { label: 'Novidades',     href: '/produtos?ord=novos' },
            { label: 'Mais vendidos', href: '/produtos?ord=top' },
            { label: 'Ofertas',       href: '/produtos?ord=promo' },
          ],
        },
        {
          title: 'Atendimento',
          links: [
            { label: 'Fale conosco',        href: '/p/contato' },
            { label: 'Trocas e devoluções', href: '/p/trocas' },
            { label: 'Entrega',             href: '/p/entrega' },
          ],
        },
        {
          title: 'Institucional',
          links: [
            { label: 'Sobre nós',           href: '/p/sobre' },
            { label: 'Política de privacidade', href: '/p/privacidade' },
            { label: 'Termos de uso',       href: '/p/termos' },
          ],
        },
      ],
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Page factories genericas (usadas por todos os templates)
// ─────────────────────────────────────────────────────────────────────────

function makeProductPage(tpl: string, opts?: { stickyCart?: boolean; layoutPos?: 'left' | 'right' | 'top' }): PageDesign {
  const breadcrumb: BreadcrumbSection = {
    id: id(tpl, 'product', 1),
    type: 'breadcrumb',
    settings: { showHome: true, separator: '/' },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    { paddingTop: 16, paddingBottom: 16, marginTop: 0, marginBottom: 0 },
    background: bgNone(),
  }
  const detail: ProductDetailLayoutSection = {
    id: id(tpl, 'product', 2),
    type: 'productDetailLayout',
    settings: {
      galleryPosition:     opts?.layoutPos ?? 'left',
      galleryStyle:        'carousel',
      stickyAddToCart:     opts?.stickyCart ?? true,
      showShareButtons:    true,
      showRelatedProducts: true,
      relatedProductsCount: 4,
      showReviews:         false,
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
  }
  return {
    sections: [breadcrumb, detail],
    seo: { title: '{{product.name}} — {{store.name}}', description: '{{product.short}}' },
    layout: 'default',
  }
}

function makeCollectionPage(tpl: string): PageDesign {
  const breadcrumb: BreadcrumbSection = {
    id: id(tpl, 'collection', 1),
    type: 'breadcrumb',
    settings: { showHome: true, separator: '/' },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    { paddingTop: 16, paddingBottom: 16, marginTop: 0, marginBottom: 0 },
    background: bgNone(),
  }
  const grid: ProductGridSection = {
    id: id(tpl, 'collection', 2),
    type: 'productGrid',
    settings: {
      title:       undefined,
      source:      { kind: 'collection', collectionId: '{{collection.id}}' },
      columns:     { mobile: 2, tablet: 3, desktop: 4 },
      limit:       60,
      showFilters: true,
      showSort:    true,
      cardStyle:   'detailed',
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
  }
  return {
    sections: [breadcrumb, grid],
    seo: { title: '{{collection.name}} — {{store.name}}' },
    layout: 'default',
  }
}

function makeCartPage(tpl: string): PageDesign {
  const cart: CartLayoutSection = {
    id: id(tpl, 'cart', 1),
    type: 'cartLayout',
    settings: {
      showCoupon:   true,
      showShipping: true,
      showNotes:    true,
      trustBadges:  [],
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
  }
  return {
    sections: [cart],
    seo: { title: 'Carrinho — {{store.name}}' },
    layout: 'default',
  }
}

function makeCheckoutPage(tpl: string): PageDesign {
  const checkout: CheckoutLayoutSection = {
    id: id(tpl, 'checkout', 1),
    type: 'checkoutLayout',
    settings: {
      steps:          'multi',
      requireAccount: false,
      askForCpf:      true,
      askForCnpj:     false,
      trustBadges:    [],
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
    // Mobile-first: checkout em 1 step é muito melhor pra conversão no celular.
    mobileOverrides: { settings: { steps: 'single' } },
  }
  return {
    sections: [checkout],
    seo: { title: 'Finalizar compra — {{store.name}}' },
    layout: 'default',
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Template 1 — LUSTRES DECOR (Vazzo Lustres Online)
// Classico/sofisticado: creme + dourado + serifa elegante.
// ─────────────────────────────────────────────────────────────────────────

const lustresTheme: ThemeV3 = {
  mode: 'light',
  colors: {
    background: '#f8f4ec',
    surface:    '#ffffff',
    primary:    '#c9a961',
    text:       '#2a2620',
    textMuted:  '#8a7f6e',
    border:     '#e8dfcc',
    dark:       '#1f1c17',
    watermark:  '#efe6d2',
    onAccent:   '#1f1c17',
    success:    '#5b8b5e',
    error:      '#c0594e',
    warning:    '#d4a55a',
  },
  fontPair: 'editorial',
  radius:   'sm',
  density:  'spacious',
  effects:  { scrollReveal: true, watermarks: true, parallaxTilt: true, hoverRollover: true },
  buttons:  { style: 'sharp', weight: 'normal' },
}

function lustresHome(): PageDesign {
  const TPL = 'lustres'
  const announcement: AnnouncementBarSection = {
    id: id(TPL, 'home', 1),
    type: 'announcementBar',
    settings: {
      message:     'Frete grátis acima de R$ 499 para todo o Brasil',
      ctaLabel:    'Ver coleção',
      ctaHref:     '/produtos',
      countdownTo: null,
      dismissible: false,
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    { paddingTop: 12, paddingBottom: 12, marginTop: 0, marginBottom: 0 },
    background: bgColor('#1f1c17'),
  }
  const slider: SliderSection = {
    id: id(TPL, 'home', 2),
    type: 'slider',
    settings: { autoplay: true, interval: 6, showDots: true, showArrows: true, effect: 'fade', height: 'lg' },
    blocks: [
      { id: bid(id(TPL, 'home', 2), 1), type: 'slide', settings: {
        imageUrl: '', headline: 'Iluminação que transforma ambientes',
        subheadline: 'Curadoria editorial de lustres clássicos e contemporâneos',
        ctaLabel: 'Explorar coleção', ctaHref: '/produtos',
        textColor: '#fafafa', textAlign: 'left',
      }},
      { id: bid(id(TPL, 'home', 2), 2), type: 'slide', settings: {
        imageUrl: '', headline: 'Coleção Dourada — edição limitada',
        subheadline: 'Peças únicas em metal envelhecido',
        ctaLabel: 'Ver edição', ctaHref: '/produtos?ord=novos',
        textColor: '#fafafa', textAlign: 'left',
      }},
    ],
    visibility: defaultVisibility(),
    spacing:    noSpacing(),
    background: bgNone(),
    // Mobile-first: lg (~600px) ofusca produtos no celular. Em mobile cai pra md.
    mobileOverrides: { settings: { height: 'md', showArrows: false } },
  }
  const carousel: ProductCarouselSection = {
    id: id(TPL, 'home', 3),
    type: 'productCarousel',
    settings: {
      title: 'Em destaque',
      source: { kind: 'bestsellers' } as ProductSource,
      limit: 12, autoplay: false, cardStyle: 'detailed',
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
  }
  const categories: CollectionGridSection = {
    id: id(TPL, 'home', 4),
    type: 'collectionGrid',
    settings: {
      title: 'Navegue por ambiente',
      columns: { mobile: 2, tablet: 3, desktop: 4 },
      collections: [
        { collectionId: '{{collection.living}}',  label: 'Sala de Estar' },
        { collectionId: '{{collection.dining}}',  label: 'Sala de Jantar' },
        { collectionId: '{{collection.bedroom}}', label: 'Quarto' },
        { collectionId: '{{collection.hall}}',    label: 'Hall de Entrada' },
      ],
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgColor('#f1ecde'),
  }
  const editorial: ImageWithTextSection = {
    id: id(TPL, 'home', 5),
    type: 'imageWithText',
    settings: {
      imageUrl: '', imageSide: 'right',
      title: 'Feito para iluminar histórias',
      body:  'Cada peça da nossa coleção é selecionada uma a uma. Atendemos arquitetos, designers e amantes de boa iluminação em todo o Brasil — com entrega cuidadosa e instalação assistida.',
      ctaLabel: 'Conheça nossa história', ctaHref: '/p/sobre',
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
  }
  const grid: ProductGridSection = {
    id: id(TPL, 'home', 6),
    type: 'productGrid',
    settings: {
      title: 'Catálogo completo',
      source: { kind: 'storefront' } as ProductSource,
      columns: { mobile: 2, tablet: 3, desktop: 4 },
      limit: 24, showFilters: false, showSort: false, cardStyle: 'detailed',
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
  }
  const testimonials: TestimonialsSection = {
    id: id(TPL, 'home', 7),
    type: 'testimonials',
    settings: {
      title: 'O que dizem nossos clientes',
      layout: 'grid',
      items: [
        { id: 't1', name: 'Ana Carolina', text: 'Lustre lindíssimo, embalagem impecável. Recomendo!', rating: 5 },
        { id: 't2', name: 'Roberto Lima', text: 'Atendimento atencioso e produto de qualidade premium.', rating: 5 },
        { id: 't3', name: 'Marina Souza', text: 'Coleção sofisticada. Encontrei a peça perfeita para minha sala.', rating: 5 },
      ],
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgColor('#f1ecde'),
  }
  const newsletter: NewsletterSection = {
    id: id(TPL, 'home', 8),
    type: 'newsletter',
    settings: {
      title: 'Receba lançamentos em primeira mão',
      description: 'Cadastre seu email e tenha acesso antecipado às novas coleções.',
      ctaLabel: 'Quero receber', placeholder: 'seu@email.com',
      successMessage: 'Obrigado! Em breve você receberá nossas novidades.',
    },
    blocks: [],
    visibility: defaultVisibility(),
    spacing:    defaultSpacing(),
    background: bgNone(),
  }
  return {
    sections: [announcement, slider, carousel, categories, editorial, grid, testimonials, newsletter],
    seo: { title: '{{store.name}} — Iluminação editorial para sua casa' },
    layout: 'default',
  }
}

const LUSTRES_DECOR: StorefrontDesignV3 = {
  version: 3,
  theme: lustresTheme,
  globals: {
    header: makeHeader('lustres', {
      variant: 'split', sticky: true, logoText: 'Lustres Online',
      nav: [
        { label: 'Início',         href: '/' },
        { label: 'Sala',           href: '/produtos?cat=sala' },
        { label: 'Quarto',         href: '/produtos?cat=quarto' },
        { label: 'Hall',           href: '/produtos?cat=hall' },
        { label: 'Ofertas',        href: '/produtos?ord=promo' },
        { label: 'Sobre',          href: '/p/sobre' },
      ],
    }),
    footer: makeFooter('lustres', { variant: 'columns', showNewsletter: true,
      copyright: '© Lustres Online — Iluminação que transforma' }),
  },
  pages: {
    home:       lustresHome(),
    product:    makeProductPage('lustres', { stickyCart: true, layoutPos: 'left' }),
    collection: makeCollectionPage('lustres'),
    cart:       makeCartPage('lustres'),
    checkout:   makeCheckoutPage('lustres'),
  },
  meta: { templateKey: 'lustres-decor', updatedAt: new Date().toISOString() },
}

// ─────────────────────────────────────────────────────────────────────────
// Template 2 — FASHION HANDBAG
// Moda/acessorios: paleta neutra (preto/branco/nude), tipografia moderna.
// ─────────────────────────────────────────────────────────────────────────

const fashionTheme: ThemeV3 = {
  mode: 'light',
  colors: {
    background: '#ffffff',
    surface:    '#fafafa',
    primary:    '#1a1a1a',
    text:       '#1a1a1a',
    textMuted:  '#8a8a8a',
    border:     '#ececec',
    dark:       '#0a0a0a',
    watermark:  '#f4f4f4',
    onAccent:   '#ffffff',
  },
  fontPair: 'modern',
  radius:   'none',
  density:  'cozy',
  effects:  { scrollReveal: true, watermarks: false, parallaxTilt: false, hoverRollover: true },
  buttons:  { style: 'sharp', weight: 'normal' },
}

function fashionHome(): PageDesign {
  const TPL = 'fashion'
  const announcement: AnnouncementBarSection = {
    id: id(TPL, 'home', 1), type: 'announcementBar',
    settings: { message: 'Frete grátis em todo o Brasil acima de R$ 299', countdownTo: null, dismissible: true },
    blocks: [], visibility: defaultVisibility(),
    spacing: { paddingTop: 10, paddingBottom: 10, marginTop: 0, marginBottom: 0 },
    background: bgColor('#0a0a0a'),
  }
  const hero: HeroSection = {
    id: id(TPL, 'home', 2), type: 'hero',
    settings: { layout: 'overlay', height: 'fullscreen', textAlign: 'left' },
    blocks: [
      { id: bid(id(TPL, 'home', 2), 1), type: 'heading', settings: { text: 'Coleção Outono 2026', level: 1, align: 'left' }},
      { id: bid(id(TPL, 'home', 2), 2), type: 'subheading', settings: { text: 'A elegância em cada detalhe', align: 'left' }},
      { id: bid(id(TPL, 'home', 2), 3), type: 'button', settings: { label: 'Comprar agora', href: '/produtos', style: 'primary', size: 'lg', newTab: false }},
    ],
    visibility: defaultVisibility(),
    spacing: noSpacing(),
    background: { kind: 'image', imageUrl: '', imageFocus: 'center', overlayColor: '#000000', overlayOpacity: 0.3 },
    // Mobile-first: fullscreen empurra produtos pra baixo da dobra no celular. Em mobile vira lg.
    mobileOverrides: { settings: { height: 'lg', textAlign: 'center' } },
  }
  const grid1: ProductGridSection = {
    id: id(TPL, 'home', 3), type: 'productGrid',
    settings: {
      title: 'Novidades',
      source: { kind: 'newest' } as ProductSource,
      columns: { mobile: 2, tablet: 3, desktop: 4 },
      limit: 8, showFilters: false, showSort: false, cardStyle: 'minimal',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  const categories: CollectionGridSection = {
    id: id(TPL, 'home', 4), type: 'collectionGrid',
    settings: {
      columns: { mobile: 2, tablet: 4, desktop: 4 },
      collections: [
        { collectionId: '{{collection.bags}}',    label: 'Bolsas' },
        { collectionId: '{{collection.wallets}}', label: 'Carteiras' },
        { collectionId: '{{collection.belts}}',   label: 'Cintos' },
        { collectionId: '{{collection.acc}}',     label: 'Acessórios' },
      ],
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  const carousel: ProductCarouselSection = {
    id: id(TPL, 'home', 5), type: 'productCarousel',
    settings: { title: 'Mais desejados', source: { kind: 'bestsellers' } as ProductSource, limit: 12, autoplay: false, cardStyle: 'minimal' },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgColor('#fafafa'),
  }
  const editorial: ImageWithTextSection = {
    id: id(TPL, 'home', 6), type: 'imageWithText',
    settings: {
      imageUrl: '', imageSide: 'left',
      title: 'Feito à mão, pensado para você',
      body:  'Bolsas e acessórios produzidos em ateliê, com couro selecionado e acabamento artesanal.',
      ctaLabel: 'Nossa história', ctaHref: '/p/sobre',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  return {
    sections: [announcement, hero, grid1, categories, carousel, editorial],
    seo: { title: '{{store.name}} — Bolsas e acessórios artesanais' },
    layout: 'default',
  }
}

const FASHION_HANDBAG: StorefrontDesignV3 = {
  version: 3,
  theme: fashionTheme,
  globals: {
    header: makeHeader('fashion', { variant: 'centered', sticky: true, logoText: 'Boutique',
      nav: [
        { label: 'Bolsas',      href: '/produtos?cat=bolsas' },
        { label: 'Carteiras',   href: '/produtos?cat=carteiras' },
        { label: 'Cintos',      href: '/produtos?cat=cintos' },
        { label: 'Acessórios',  href: '/produtos?cat=acessorios' },
        { label: 'Lookbook',    href: '/p/lookbook' },
      ],
    }),
    footer: makeFooter('fashion', { variant: 'columns' }),
  },
  pages: {
    home:       fashionHome(),
    product:    makeProductPage('fashion', { stickyCart: true, layoutPos: 'left' }),
    collection: makeCollectionPage('fashion'),
    cart:       makeCartPage('fashion'),
    checkout:   makeCheckoutPage('fashion'),
  },
  meta: { templateKey: 'fashion-handbag', updatedAt: new Date().toISOString() },
}

// ─────────────────────────────────────────────────────────────────────────
// Template 3 — MINIMAL CATALOG
// Genérico amplo SKU: header sticky com busca, sem hero, foco em filtros.
// ─────────────────────────────────────────────────────────────────────────

const minimalTheme: ThemeV3 = {
  mode: 'light',
  colors: {
    background: '#ffffff',
    surface:    '#fafafa',
    primary:    '#0066ff',
    text:       '#1a1a1a',
    textMuted:  '#6b7280',
    border:     '#e5e7eb',
    dark:       '#111111',
    watermark:  '#f3f4f6',
    onAccent:   '#ffffff',
  },
  fontPair: 'modern',
  radius:   'md',
  density:  'compact',
  effects:  { scrollReveal: false, watermarks: false, parallaxTilt: false, hoverRollover: true },
  buttons:  { style: 'solid', weight: 'normal' },
}

function minimalHome(): PageDesign {
  const TPL = 'minimal'
  const banner: ImageBannerSection = {
    id: id(TPL, 'home', 1), type: 'imageBanner',
    settings: {
      imageUrl: '', headline: 'Catálogo completo', subheadline: 'Frete rápido para todo o Brasil',
      ctaLabel: 'Ver produtos', ctaHref: '/produtos',
      textPosition: 'center', height: 'md',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: noSpacing(), background: bgNone(),
  }
  const categories: CollectionGridSection = {
    id: id(TPL, 'home', 2), type: 'collectionGrid',
    settings: {
      title: 'Categorias',
      columns: { mobile: 2, tablet: 4, desktop: 6 },
      collections: [
        { collectionId: '{{collection.cat1}}', label: 'Categoria 1' },
        { collectionId: '{{collection.cat2}}', label: 'Categoria 2' },
        { collectionId: '{{collection.cat3}}', label: 'Categoria 3' },
        { collectionId: '{{collection.cat4}}', label: 'Categoria 4' },
        { collectionId: '{{collection.cat5}}', label: 'Categoria 5' },
        { collectionId: '{{collection.cat6}}', label: 'Categoria 6' },
      ],
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  const grid: ProductGridSection = {
    id: id(TPL, 'home', 3), type: 'productGrid',
    settings: {
      title: 'Todos os produtos',
      source: { kind: 'storefront' } as ProductSource,
      columns: { mobile: 2, tablet: 3, desktop: 4 },
      limit: 48, showFilters: true, showSort: true, cardStyle: 'compact',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  return {
    sections: [banner, categories, grid],
    seo: { title: '{{store.name}} — Catálogo completo' },
    layout: 'default',
  }
}

const MINIMAL_CATALOG: StorefrontDesignV3 = {
  version: 3,
  theme: minimalTheme,
  globals: {
    header: makeHeader('minimal', { variant: 'split', sticky: true, logoText: 'Loja' }),
    footer: makeFooter('minimal', { variant: 'columns', showNewsletter: false }),
  },
  pages: {
    home:       minimalHome(),
    product:    makeProductPage('minimal', { stickyCart: true, layoutPos: 'left' }),
    collection: makeCollectionPage('minimal'),
    cart:       makeCartPage('minimal'),
    checkout:   makeCheckoutPage('minimal'),
  },
  meta: { templateKey: 'minimal-catalog', updatedAt: new Date().toISOString() },
}

// ─────────────────────────────────────────────────────────────────────────
// Template 4 — BOLD PROMO
// Promocional/vibrante: cores vivas, countdown, badges fortes.
// ─────────────────────────────────────────────────────────────────────────

const boldTheme: ThemeV3 = {
  mode: 'light',
  colors: {
    background: '#fff7f1',
    surface:    '#ffffff',
    primary:    '#ff3366',
    text:       '#1a1a2e',
    textMuted:  '#6c6c80',
    border:     '#ffd9c7',
    dark:       '#1a1a2e',
    watermark:  '#ffe2d0',
    onAccent:   '#ffffff',
    success:    '#10b981',
    error:      '#dc2626',
    warning:    '#f59e0b',
  },
  fontPair: 'bold',
  radius:   'lg',
  density:  'cozy',
  effects:  { scrollReveal: true, watermarks: true, parallaxTilt: false, hoverRollover: true },
  buttons:  { style: 'pill', weight: 'bold' },
}

function boldHome(): PageDesign {
  const TPL = 'bold'
  const future = new Date(); future.setDate(future.getDate() + 3)
  const announcement: AnnouncementBarSection = {
    id: id(TPL, 'home', 1), type: 'announcementBar',
    settings: {
      message:     'MEGA PROMOÇÃO — até 70% OFF',
      ctaLabel:    'Aproveitar',
      ctaHref:     '/produtos?ord=promo',
      countdownTo: future.toISOString(),
      dismissible: false,
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: { paddingTop: 14, paddingBottom: 14, marginTop: 0, marginBottom: 0 },
    background: bgColor('#ff3366'),
  }
  const marquee: MarqueeSection = {
    id: id(TPL, 'home', 2), type: 'marquee',
    settings: {
      items: ['ENVIO EM 24H', 'PARCELE EM 12X', 'TROCA GRÁTIS', 'PIX COM DESCONTO', 'FRETE GRÁTIS'],
      speed: 'normal', direction: 'left',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: { paddingTop: 8, paddingBottom: 8, marginTop: 0, marginBottom: 0 },
    background: bgColor('#1a1a2e'),
  }
  const hero: HeroSection = {
    id: id(TPL, 'home', 3), type: 'hero',
    settings: { layout: 'split', height: 'lg', textAlign: 'left' },
    blocks: [
      { id: bid(id(TPL, 'home', 3), 1), type: 'badge', settings: { text: 'PROMOÇÃO RELÂMPAGO', color: 'error' }},
      { id: bid(id(TPL, 'home', 3), 2), type: 'heading', settings: { text: 'Tudo com até 70% OFF', level: 1, align: 'left' }},
      { id: bid(id(TPL, 'home', 3), 3), type: 'paragraph', settings: { text: 'Aproveite antes que acabe. Estoque limitado.', align: 'left' }},
      { id: bid(id(TPL, 'home', 3), 4), type: 'button', settings: { label: 'Ver ofertas', href: '/produtos?ord=promo', style: 'primary', size: 'lg', newTab: false }},
    ],
    visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgColor('#fff7f1'),
  }
  const carousel: ProductCarouselSection = {
    id: id(TPL, 'home', 4), type: 'productCarousel',
    settings: { title: '🔥 Em promoção', source: { kind: 'promo' } as ProductSource, limit: 16, autoplay: true, cardStyle: 'detailed' },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  const grid: ProductGridSection = {
    id: id(TPL, 'home', 5), type: 'productGrid',
    settings: {
      title: 'Mais vendidos',
      source: { kind: 'bestsellers' } as ProductSource,
      columns: { mobile: 2, tablet: 3, desktop: 4 },
      limit: 16, showFilters: false, showSort: false, cardStyle: 'detailed',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  const newsletter: NewsletterSection = {
    id: id(TPL, 'home', 6), type: 'newsletter',
    settings: {
      title: 'Cupom de 10% no seu primeiro pedido',
      description: 'Cadastre seu email e receba o cupom no instante.',
      ctaLabel: 'Quero o cupom', placeholder: 'seu@email.com',
      successMessage: 'Cupom enviado! Confira sua caixa de entrada.',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgColor('#ff3366'),
  }
  return {
    sections: [announcement, marquee, hero, carousel, grid, newsletter],
    seo: { title: '{{store.name}} — Promoções imperdíveis' },
    layout: 'default',
  }
}

const BOLD_PROMO: StorefrontDesignV3 = {
  version: 3,
  theme: boldTheme,
  globals: {
    header: makeHeader('bold', { variant: 'split', sticky: true, logoText: 'OFERTAS' }),
    footer: makeFooter('bold', { variant: 'columns', showNewsletter: true }),
  },
  pages: {
    home:       boldHome(),
    product:    makeProductPage('bold', { stickyCart: true, layoutPos: 'right' }),
    collection: makeCollectionPage('bold'),
    cart:       makeCartPage('bold'),
    checkout:   makeCheckoutPage('bold'),
  },
  meta: { templateKey: 'bold-promo', updatedAt: new Date().toISOString() },
}

// ─────────────────────────────────────────────────────────────────────────
// Template 5 — TECH ELECTRONICS
// Eletrônicos: dark mode, accent ciano, featuredProduct, specs.
// ─────────────────────────────────────────────────────────────────────────

const techTheme: ThemeV3 = {
  mode: 'dark',
  colors: {
    background: '#0a0a0e',
    surface:    '#111114',
    primary:    '#00e5ff',
    text:       '#fafafa',
    textMuted:  '#a1a1aa',
    border:     '#27272a',
    dark:       '#000000',
    watermark:  '#16161a',
    onAccent:   '#0a0a0e',
    success:    '#22c55e',
    error:      '#ef4444',
    warning:    '#eab308',
  },
  fontPair: 'modern',
  radius:   'md',
  density:  'cozy',
  effects:  { scrollReveal: true, watermarks: false, parallaxTilt: true, hoverRollover: true },
  buttons:  { style: 'solid', weight: 'bold' },
}

function techHome(): PageDesign {
  const TPL = 'tech'
  const announcement: AnnouncementBarSection = {
    id: id(TPL, 'home', 1), type: 'announcementBar',
    settings: {
      message:     'Compre em 12x sem juros + Frete grátis acima de R$ 999',
      countdownTo: null, dismissible: false,
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: { paddingTop: 10, paddingBottom: 10, marginTop: 0, marginBottom: 0 },
    background: bgColor('#00e5ff'),
  }
  const hero: HeroSection = {
    id: id(TPL, 'home', 2), type: 'hero',
    settings: { layout: 'split', height: 'lg', textAlign: 'left' },
    blocks: [
      { id: bid(id(TPL, 'home', 2), 1), type: 'subheading', settings: { text: 'Lançamento', align: 'left' }},
      { id: bid(id(TPL, 'home', 2), 2), type: 'heading', settings: { text: 'Tecnologia que move o futuro', level: 1, align: 'left' }},
      { id: bid(id(TPL, 'home', 2), 3), type: 'paragraph', settings: { text: 'Produtos selecionados com garantia oficial e suporte especializado.', align: 'left' }},
      { id: bid(id(TPL, 'home', 2), 4), type: 'button', settings: { label: 'Ver lançamentos', href: '/produtos?ord=novos', style: 'primary', size: 'lg', newTab: false }},
    ],
    visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgColor('#0a0a0e'),
  }
  const featured: FeaturedProductSection = {
    id: id(TPL, 'home', 3), type: 'featuredProduct',
    settings: {
      productId: '{{featured.product}}', galleryPosition: 'right',
      showDescription: true, showAttributes: true, ctaLabel: 'Comprar agora',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgColor('#111114'),
  }
  const carousel: ProductCarouselSection = {
    id: id(TPL, 'home', 4), type: 'productCarousel',
    settings: { title: 'Mais vendidos', source: { kind: 'bestsellers' } as ProductSource, limit: 12, autoplay: false, cardStyle: 'detailed' },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  const categories: CollectionGridSection = {
    id: id(TPL, 'home', 5), type: 'collectionGrid',
    settings: {
      title: 'Categorias',
      columns: { mobile: 2, tablet: 4, desktop: 4 },
      collections: [
        { collectionId: '{{collection.smartphones}}', label: 'Smartphones' },
        { collectionId: '{{collection.notebooks}}',   label: 'Notebooks' },
        { collectionId: '{{collection.audio}}',       label: 'Áudio' },
        { collectionId: '{{collection.gaming}}',      label: 'Gaming' },
      ],
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  const grid: ProductGridSection = {
    id: id(TPL, 'home', 6), type: 'productGrid',
    settings: {
      title: 'Catálogo',
      source: { kind: 'storefront' } as ProductSource,
      columns: { mobile: 2, tablet: 3, desktop: 4 },
      limit: 24, showFilters: true, showSort: true, cardStyle: 'detailed',
    },
    blocks: [], visibility: defaultVisibility(),
    spacing: defaultSpacing(), background: bgNone(),
  }
  return {
    sections: [announcement, hero, featured, carousel, categories, grid],
    seo: { title: '{{store.name}} — Tecnologia com garantia oficial' },
    layout: 'default',
  }
}

const TECH_ELECTRONICS: StorefrontDesignV3 = {
  version: 3,
  theme: techTheme,
  globals: {
    header: makeHeader('tech', { variant: 'split', sticky: true, logoText: 'Tech Store',
      nav: [
        { label: 'Início',      href: '/' },
        { label: 'Smartphones', href: '/produtos?cat=smartphones' },
        { label: 'Notebooks',   href: '/produtos?cat=notebooks' },
        { label: 'Áudio',       href: '/produtos?cat=audio' },
        { label: 'Gaming',      href: '/produtos?cat=gaming' },
        { label: 'Suporte',     href: '/p/contato' },
      ],
    }),
    footer: makeFooter('tech', { variant: 'columns', showNewsletter: true }),
  },
  pages: {
    home:       techHome(),
    product:    makeProductPage('tech', { stickyCart: true, layoutPos: 'left' }),
    collection: makeCollectionPage('tech'),
    cart:       makeCartPage('tech'),
    checkout:   makeCheckoutPage('tech'),
  },
  meta: { templateKey: 'tech-electronics', updatedAt: new Date().toISOString() },
}

// ─────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────

export interface StorefrontTemplateV3 {
  id:          string
  label:       string
  description: string
  niche:       string
  design:      StorefrontDesignV3
}

export const STOREFRONT_TEMPLATES_V3: StorefrontTemplateV3[] = [
  {
    id: 'lustres-decor',
    label: 'Lustres & Decoração',
    description: 'Estilo editorial clássico, paleta creme/dourado, fonte serifa. Ideal para iluminação, decoração e ticket alto.',
    niche: 'decoração',
    design: LUSTRES_DECOR,
  },
  {
    id: 'fashion-handbag',
    label: 'Moda & Acessórios',
    description: 'Visual clean preto/branco, hero fullscreen, foco em fotografia. Ideal para bolsas, roupas e acessórios.',
    niche: 'moda',
    design: FASHION_HANDBAG,
  },
  {
    id: 'minimal-catalog',
    label: 'Catálogo Amplo',
    description: 'Sem hero, grid denso com filtros e busca proeminente. Ideal para lojas com muitos SKUs.',
    niche: 'catálogo',
    design: MINIMAL_CATALOG,
  },
  {
    id: 'bold-promo',
    label: 'Promoção Vibrante',
    description: 'Cores fortes, countdown, badges de desconto, marquee. Ideal para datas comerciais e queima de estoque.',
    niche: 'promocional',
    design: BOLD_PROMO,
  },
  {
    id: 'tech-electronics',
    label: 'Eletrônicos',
    description: 'Dark mode, accent ciano, destaque para 1 produto premium, foco em specs. Ideal para tecnologia.',
    niche: 'eletrônicos',
    design: TECH_ELECTRONICS,
  },
]

export const STOREFRONT_TEMPLATE_V3_MAP: Record<string, StorefrontTemplateV3> =
  Object.fromEntries(STOREFRONT_TEMPLATES_V3.map(t => [t.id, t]))

/** Design padrao usado quando a loja v3 ainda nao tem design definido. */
export const DEFAULT_DESIGN_V3: StorefrontDesignV3 = LUSTRES_DECOR
