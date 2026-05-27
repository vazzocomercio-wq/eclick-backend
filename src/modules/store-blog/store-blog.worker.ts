import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StoreBlogService } from './store-blog.service';

/**
 * Worker de publicação agendada do Blog da Loja. Tick a cada 2min: publica
 * os posts 'scheduled' cujo horário já passou. Desligável via env
 * STORE_BLOG_PUBLISHER_DISABLED=true.
 */
@Injectable()
export class StoreBlogWorker {
  private readonly log = new Logger(StoreBlogWorker.name);

  constructor(private readonly svc: StoreBlogService) {}

  @Cron('*/2 * * * *', { name: 'store-blog-publisher' })
  async tick(): Promise<void> {
    if (process.env.STORE_BLOG_PUBLISHER_DISABLED === 'true') return;
    try {
      const n = await this.svc.publishDue();
      if (n) this.log.log(`[store-blog] publicou ${n} agendado(s)`);
    } catch (e) {
      this.log.warn(`[store-blog] worker falhou: ${(e as Error).message}`);
    }
  }
}
