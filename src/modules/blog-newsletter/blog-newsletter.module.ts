import { Module } from '@nestjs/common';
import { EmailSettingsModule } from '../email-settings/email-settings.module';
import { InternalKeyGuard } from '../internal/internal-key.guard';
import { BlogNewsletterService } from './blog-newsletter.service';
import { BlogNewsletterBroadcastService } from './blog-newsletter-broadcast.service';
import {
  BlogNewsletterInternalController,
  BlogNewsletterPublicController,
} from './blog-newsletter.controller';

/**
 * Newsletter do blog público (eclick.app.br/blog). NÃO é multi-tenant —
 * é a newsletter DA e-Click. Captura no widget público + broadcast quando
 * o Active publica um post novo no Sanity.
 */
@Module({
  imports: [EmailSettingsModule],
  controllers: [BlogNewsletterPublicController, BlogNewsletterInternalController],
  providers: [BlogNewsletterService, BlogNewsletterBroadcastService, InternalKeyGuard],
  exports: [BlogNewsletterService],
})
export class BlogNewsletterModule {}
