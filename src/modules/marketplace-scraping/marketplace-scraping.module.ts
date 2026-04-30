import { Module } from '@nestjs/common'
import { ScraperService } from '../scraper/scraper.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MarketplaceScrapingService } from './marketplace-scraping.service'

/** Sprint F5-2 — wrapper modernizado de scraping de marketplaces.
 * Importa ScraperService legacy pra delegação de detectPlatform e
 * fallbacks; CampaignsService usa esse module pra search/import/galeria.
 * Importa MercadolivreModule pra reusar getTokenForOrg() com refresh
 * automático (Batch 1.12.1 — corrige token cru via api_credentials). */
@Module({
  imports:   [MercadolivreModule],
  providers: [MarketplaceScrapingService, ScraperService],
  exports:   [MarketplaceScrapingService],
})
export class MarketplaceScrapingModule {}
