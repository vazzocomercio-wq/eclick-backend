/**
 * Tipos do Blog da Loja (épico SB). A IA devolve `RawArticle` (seções simples)
 * que o service converte pra Portable Text-like blocks renderizados na vitrine.
 */

export interface GenerateStorePostDto {
  topic: string;
  /** ids de produtos da loja a apresentar/linkar no artigo (opcional; senão a IA escolhe dos visíveis). */
  productIds?: string[];
  notes?: string;
  generateCover?: boolean;
}

export interface IdeateStoreDto {
  seed?: string;
  count?: number;
}

export interface StoreTopicIdea {
  title: string;
  angle: string;
  why: string;
  aiPrompts: string[];
  productIds?: string[];
}

export interface RawArticleBlock {
  type: 'stat' | 'paperQuote' | 'callout' | 'comparison' | 'image' | 'productGrid';
  // image
  prompt?: string;
  alt?: string;
  caption?: string;
  // productGrid (apresenta produtos reais da loja)
  productIds?: string[];
  // stat
  value?: string;
  label?: string;
  source?: string;
  // paperQuote
  quote?: string;
  paperTitle?: string;
  authors?: string;
  venue?: string;
  url?: string;
  // callout
  variant?: 'info' | 'warning' | 'tip' | 'science' | 'case';
  title?: string;
  body?: string;
  // comparison
  leftLabel?: string;
  rightLabel?: string;
  rows?: Array<{ aspect?: string; left?: string; right?: string }>;
}

export interface RawArticleSection {
  heading?: string;
  paragraphs?: string[];
  blocks?: RawArticleBlock[];
}

export interface RawArticle {
  title: string;
  slug?: string;
  excerpt: string;
  tldr: string[];
  sections: RawArticleSection[];
  faq?: Array<{ question: string; answer: string }>;
  aiPrompts?: string[];
  citationSources?: Array<{ title: string; url?: string; authorOrOrg?: string; year?: number }>;
  tags?: string[];
  featuredProductIds?: string[];
  seoTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
  coverImagePrompt?: string;
  readingTimeMinutes?: number;
}

export interface PortableTextNode {
  _type: string;
  _key: string;
  [k: string]: unknown;
}

export type StorePostStatus =
  | 'generating'
  | 'review'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'failed'
  | 'archived';

export interface StoreBlogPostRow {
  id: string;
  organization_id: string;
  created_by: string | null;
  title: string;
  slug: string;
  excerpt: string | null;
  tldr: string[];
  body: PortableTextNode[];
  faq: Array<{ question: string; answer: string }>;
  ai_prompts: string[];
  citation_sources: Array<{ title: string; url?: string; authorOrOrg?: string; year?: number }>;
  category: string | null;
  tags: string[];
  featured_product_ids: string[];
  cover_image_url: string | null;
  seo_title: string | null;
  meta_description: string | null;
  focus_keyword: string | null;
  reading_time_minutes: number | null;
  status: StorePostStatus;
  scheduled_for: string | null;
  published_at: string | null;
  rejected_reason: string | null;
  source_topic: string | null;
  cost_usd: number;
  generation_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Produto da loja (contexto pra IA + render do productGrid). */
export interface StoreProductLite {
  id: string;
  name: string;
  category: string | null;
  brand: string | null;
  price: number;
  photo_url: string | null;
  short_description: string | null;
}
