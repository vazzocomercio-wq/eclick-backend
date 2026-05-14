import { Module } from '@nestjs/common'
import { EOtimizerController } from './e-otimizer.controller'
import { MlSearchService } from './services/ml-search.service'
import { CompetitorScorerService } from './services/competitor-scorer.service'
import { CategoryResearchService } from './services/category-research.service'
import { MlEditPermissionsService } from './services/ml-edit-permissions.service'
import { ExistingListingOptimizerService } from './services/existing-listing-optimizer.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { AiModule } from '../ai/ai.module'

/**
 * e-Otimizer IA — módulo de otimização SEO de anúncios Mercado Livre.
 *
 * MVP 1: Research Engine — analisa top 20 concorrentes de uma categoria
 * e retorna padrões de título, keywords frequentes (com rastreabilidade),
 * stats de atributos, distribuição de tipos de anúncio e bonus (Full/catálogo/frete).
 *
 * Próximos MVPs:
 *   2. Integração no Creative.generateListing (anúncio novo)
 *   3. Optimizer de anúncios existentes (respeita restrições do ML)
 *   4. Feedback loop (visits/vendas antes/depois)
 */
@Module({
  imports:     [MercadolivreModule, AiModule],
  controllers: [EOtimizerController],
  providers:   [
    MlSearchService,
    CompetitorScorerService,
    CategoryResearchService,
    MlEditPermissionsService,
    ExistingListingOptimizerService,
  ],
  exports: [
    // Exportado pro Creative consumir no MVP 2
    CategoryResearchService,
  ],
})
export class EOtimizerModule {}
