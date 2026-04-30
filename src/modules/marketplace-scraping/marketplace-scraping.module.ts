import { Module } from '@nestjs/common'
import { ScraperService } from '../scraper/scraper.service'
import { MarketplaceScrapingService } from './marketplace-scraping.service'

/** Sprint F5-2 — wrapper modernizado de scraping de marketplaces.
 * Importa ScraperService legacy pra delegação de detectPlatform e
 * fallbacks; CampaignsService usa esse module pra search/import/galeria. */
@Module({
  providers: [MarketplaceScrapingService, ScraperService],
  exports:   [MarketplaceScrapingService],
})
export class MarketplaceScrapingModule {}
