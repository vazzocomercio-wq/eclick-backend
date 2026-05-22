/** Onda 3 / S1 — tipos do Social Content Generator. */

export type SocialChannel =
  | 'instagram_post'
  | 'instagram_reels'
  | 'instagram_stories'
  | 'instagram_carousel'
  | 'tiktok_video'
  | 'facebook_post'
  | 'facebook_ads'
  | 'google_ads'
  | 'whatsapp_broadcast'
  | 'email_marketing'

export type SocialContentStatus =
  | 'draft'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'archived'

export interface SocialContent {
  id:                  string
  organization_id:     string
  product_id:          string
  user_id:             string
  channel:             SocialChannel
  content:             Record<string, unknown>
  creative_image_ids:  string[]
  creative_video_id:   string | null
  status:              SocialContentStatus
  scheduled_at:        string | null
  published_at:        string | null
  published_url:       string | null
  version:             number
  parent_id:           string | null
  generation_metadata: Record<string, unknown>
  created_at:          string
  updated_at:          string
}

export const SOCIAL_CHANNELS: SocialChannel[] = [
  'instagram_post',
  'instagram_reels',
  'instagram_stories',
  'instagram_carousel',
  'tiktok_video',
  'facebook_post',
  'facebook_ads',
  'google_ads',
  'whatsapp_broadcast',
  'email_marketing',
]

// ── e-Click Social AI — geração visual (SV1) ───────────────────────────

/** Formato da imagem social. feed=1:1, story=9:16 (story/reels), wide=16:9. */
export type SocialImageFormat = 'feed' | 'story' | 'wide'

/** Estilo visual da cena gerada. */
export type SocialImageStyle =
  | 'lifestyle'   // produto em ambiente real/uso
  | 'studio'      // fundo limpo, foco no produto
  | 'promo'       // com clima promocional/destaque
  | 'seasonal'    // temática sazonal
  | 'minimal'     // minimalista, espaço negativo
  | 'vibrant'     // cores vibrantes, energético

export const SOCIAL_IMAGE_FORMATS: SocialImageFormat[] = ['feed', 'story', 'wide']
export const SOCIAL_IMAGE_STYLES: SocialImageStyle[] = [
  'lifestyle', 'studio', 'promo', 'seasonal', 'minimal', 'vibrant',
]

export interface SocialPostImage {
  id:              string
  organization_id: string
  product_id:      string | null
  user_id:         string | null
  format:          SocialImageFormat
  style:           string | null
  prompt:          string | null
  image_url:       string
  storage_path:    string | null
  provider:        string | null
  model:           string | null
  cost_usd:        number
  created_at:      string
}
