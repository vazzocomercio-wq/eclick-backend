import { Module } from '@nestjs/common'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { PricingConfigController } from './pricing-config.controller'
import { PricingConfigService } from './pricing-config.service'
import { PricingPresetsService } from './pricing-presets.service'
import { PricingAuditService } from './pricing-audit.service'
import { ProductSnapshotService } from './signals/product-snapshot.service'
import { SignalDetectorService } from './signals/signal-detector.service'
import { SignalScannerService } from './signals/signal-scanner.service'
import { SignalNotifierService } from './signals/signal-notifier.service'
import { NotificationSettingsService } from './signals/notification-settings.service'
import { SignalsController } from './signals/signals.controller'
import { NotificationsController } from './signals/notifications.controller'

@Module({
  imports:     [WhatsAppModule], // pra WhatsAppSender + WhatsAppConfigService
  controllers: [PricingConfigController, SignalsController, NotificationsController],
  providers:   [
    // P1
    PricingConfigService, PricingPresetsService, PricingAuditService,
    // P2
    ProductSnapshotService, SignalDetectorService, SignalScannerService,
    SignalNotifierService, NotificationSettingsService,
  ],
  exports:     [PricingConfigService, PricingPresetsService, PricingAuditService],
})
export class PricingIntelligenceModule {}
