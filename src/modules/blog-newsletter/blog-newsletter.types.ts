export interface BlogNewsletterSignupDto {
  email: string;
  sourcePostSlug?: string | null;
  sourcePosition?: string | null;
  utm?: { source?: string; medium?: string; campaign?: string } | null;
}

export interface NotifySubscribersDto {
  slug: string;
  title: string;
  excerpt?: string | null;
  coverImageUrl?: string | null;
  focusKeyword?: string | null;
}

export interface BlogNewsletterSignupRow {
  id: string;
  email: string;
  status: 'active' | 'unsubscribed' | 'bounced';
  unsubscribe_token: string;
  source_post_slug: string | null;
  source_position: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
  unsubscribed_at: string | null;
}

export interface BlogNewsletterBroadcastRow {
  id: string;
  post_slug: string;
  post_title: string;
  post_excerpt: string | null;
  cover_image_url: string | null;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  total_targets: number;
  total_sent: number;
  total_failed: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}
