import { Module } from '@nestjs/common'
import { OpportunitiesController } from './opportunities.controller'
import { OpportunitiesService } from './opportunities.service'
import { ReviewFetcherService } from './review-fetcher.service'
import { PainMinerService } from './pain-miner.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MarketplaceScrapingModule } from '../marketplace-scraping/marketplace-scraping.module'
import { AiModule } from '../ai/ai.module'

/** Radar de Encaixe — descobrir acessórios 3D úteis pra produtos de grande
 *  circulação. Fluxo: adotar hospedeiro (anúncio ML) → puxar avaliações →
 *  minerar dores com IA (citação literal validada) → [F2/F3] gap scan +
 *  conceito com placar → promover pro Product OS. */
@Module({
  imports:     [MercadolivreModule, MarketplaceScrapingModule, AiModule],
  controllers: [OpportunitiesController],
  providers:   [OpportunitiesService, ReviewFetcherService, PainMinerService],
  exports:     [OpportunitiesService],
})
export class OpportunitiesModule {}
