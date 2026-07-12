import { Module } from '@nestjs/common'
import { Prod3dController } from './prod3d.controller'
import { Prod3dService } from './prod3d.service'
import { AiModule } from '../ai/ai.module'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { ChannelsModule } from '../channels/channels.module'

/** Custos de Produção 3D — custeio por absorção (R$/g). Ver prod3d.service.ts.
 * NÃO confundir com operating-costs do Financeiro: aquele rateia custos no DRE
 * de VENDA (por receita/margem); este rateia na GRAMA PRODUZIDA (fabricação). */
@Module({
  imports: [AiModule, WhatsAppModule, ChannelsModule],
  controllers: [Prod3dController],
  providers: [Prod3dService],
  exports: [Prod3dService],
})
export class Prod3dModule {}
