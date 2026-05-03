import { Global, Module } from '@nestjs/common'
import { EventsGateway } from './events.gateway'

/**
 * @Global pra que InternalController possa injetar EventsGateway sem
 * precisar import explícito em cada módulo consumidor.
 */
@Global()
@Module({
  providers: [EventsGateway],
  exports:   [EventsGateway],
})
export class EventsModule {}
