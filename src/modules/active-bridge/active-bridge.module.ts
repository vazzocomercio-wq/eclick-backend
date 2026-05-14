import { Module } from '@nestjs/common'
import { ActiveBridgeClient } from './active-bridge.client'
import { ActiveResolverService } from './active-resolver.service'

/** Módulo compartilhado com cliente HTTP do bridge SaaS↔Active +
 *  resolver que lê schema active.* via Supabase direto. Reusado por
 *  store-automation, social-content, products (cadastro-dispatch), etc. */
@Module({
  providers: [ActiveBridgeClient, ActiveResolverService],
  exports:   [ActiveBridgeClient, ActiveResolverService],
})
export class ActiveBridgeModule {}
