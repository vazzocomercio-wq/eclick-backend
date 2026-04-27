import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { sha256, maskIdentifier, normalizeIdentifier } from './hash.util'
import type { EnrichmentResult } from '../providers/base-provider'

@Injectable()
export class EnrichmentCacheService {
  private readonly logger = new Logger(EnrichmentCacheService.name)

  /** Look up a cached result. Bumps hit_count + last_hit_at when hit. */
  async lookup(orgId: string, queryType: string, queryValue: string): Promise<{
    result: EnrichmentResult; provider: string
  } | null> {
    try {
      const hash = sha256(normalizeIdentifier(queryType, queryValue))
      const { data } = await supabaseAdmin
        .from('enrichment_cache')
        .select('id, result, provider_used, expires_at, hit_count')
        .eq('organization_id', orgId)
        .eq('query_type', queryType)
        .eq('query_value_hash', hash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()
      if (!data) return null

      // Best-effort hit-count bump (don't block on it)
      supabaseAdmin
        .from('enrichment_cache')
        .update({
          hit_count: ((data.hit_count as number | null) ?? 0) + 1,
          last_hit_at: new Date().toISOString(),
        })
        .eq('id', data.id)
        .then(() => { /* fire-and-forget */ })

      return { result: data.result as EnrichmentResult, provider: data.provider_used as string }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.cache.lookup] ${err?.message}`)
      return null
    }
  }

  /** Store a fresh result. TTL in days; empty results get a shorter TTL
   * so we'll retry sooner when a provider had a transient miss. */
  async store(
    orgId: string,
    queryType: string,
    queryValue: string,
    provider: string,
    result: EnrichmentResult,
    ttlDays: number,
  ): Promise<void> {
    try {
      const norm = normalizeIdentifier(queryType, queryValue)
      const ttl  = result.quality === 'empty' ? Math.min(ttlDays, 7) : ttlDays
      const expiresAt = new Date(Date.now() + ttl * 86_400_000).toISOString()

      await supabaseAdmin.from('enrichment_cache').insert({
        organization_id:    orgId,
        query_type:         queryType,
        query_value_hash:   sha256(norm),
        query_value_masked: maskIdentifier(queryType, queryValue),
        provider_used:      provider,
        result,
        result_quality:     result.quality,
        expires_at:         expiresAt,
      })
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.cache.store] ${err?.message}`)
    }
  }

  /** Daily cleanup — drops cache rows past their TTL. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup() {
    try {
      const { count } = await supabaseAdmin
        .from('enrichment_cache')
        .delete({ count: 'exact' })
        .lt('expires_at', new Date().toISOString())
      if ((count ?? 0) > 0) this.logger.log(`[enrichment.cache.cleanup] expired ${count}`)
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.cache.cleanup] ${err?.message}`)
    }
  }
}
