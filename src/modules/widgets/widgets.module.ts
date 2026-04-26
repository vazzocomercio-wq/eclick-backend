import { Module } from '@nestjs/common'
import { ChatWidgetService } from './chat-widget.service'
import { WidgetsController } from './widgets.controller'
import { WidgetPublicController } from './widget-public.controller'

@Module({
  controllers: [WidgetsController, WidgetPublicController],
  providers:   [ChatWidgetService],
  exports:     [ChatWidgetService],
})
export class WidgetsModule {}
