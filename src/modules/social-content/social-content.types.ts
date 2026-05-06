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
