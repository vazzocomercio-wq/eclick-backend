import { Module } from '@nestjs/common'
import { ScraperService } from '../scraper/scraper.service'
import { CredentialsModule } from '../credentials/credentials.module'
import { MarketplaceScrapingService } from './marketplace-scraping.service'

/** Sprint F5-2 — wrapper modernizado de scraping de marketplaces.
 * Importa ScraperService legacy pra delegação de detectPlatform e
 * fallbacks; CampaignsService usa esse module pra search/import/galeria.
 * Importa CredentialsModule pra ler ML_ACCESS_TOKEN da Vazzo (Batch 1.12). */
@Module({
  imports:   [CredentialsModule],
  providers: [MarketplaceScrapingService, ScraperService],
  exports:   [MarketplaceScrapingService],
})
export class MarketplaceScrapingModule {}
