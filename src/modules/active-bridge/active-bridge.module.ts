import { Module } from '@nestjs/common'
import { ActiveBridgeClient } from './active-bridge.client'

/** Módulo compartilhado com cliente HTTP do bridge SaaS↔Active.
 *  Reusado por store-automation, social-content (publish-now), etc. */
@Module({
  providers: [ActiveBridgeClient],
  exports:   [ActiveBridgeClient],
})
export class ActiveBridgeModule {}
