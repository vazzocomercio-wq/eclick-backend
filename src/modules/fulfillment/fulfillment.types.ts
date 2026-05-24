// F12 Fulfillment — tipos compartilhados do módulo.

export type SourceType = 'marketplace' | 'storefront' | 'b2b'

export type FulfillmentOrderStatus =
  | 'received' | 'picking' | 'packing' | 'packed' | 'shipped' | 'blocked' | 'cancelled'

export type PickStatus = 'pending' | 'in_progress' | 'picked' | 'blocked' | 'cancelled'

export type PackStatus =
  | 'awaiting_pick' | 'ready_to_pack' | 'in_progress' | 'packed' | 'blocked' | 'shipped'

export type OperatorRole = 'picker' | 'packer' | 'supervisor' | 'admin'

export type ActionType =
  | 'scan_order' | 'scan_item' | 'scan_mismatch' | 'photo_taken'
  | 'pick_complete' | 'pack_complete' | 'damage_reported' | 'label_printed'
  | 'block_pick' | 'block_pack' | 'unblock'

export type DamageSeverity = 'minor' | 'major' | 'total_loss'
export type DamageResolution = 'discard' | 'return_supplier' | 'sell_as_b' | 'pending'

export interface FulfillmentCustomer {
  name?:    string
  doc?:     string
  phone?:   string
  email?:   string
  address?: Record<string, unknown>
}

export interface SeedItem {
  sku:         string
  title?:      string
  qty:         number
  productId?:  string
  barcode?:    string
}

export interface FulfillmentSettings {
  organization_id:              string
  ai_damage_triage_enabled:     boolean
  ai_pack_verification_enabled: boolean
  ai_smart_queue_enabled:       boolean
  photo_required_always:        boolean
  photo_required_above_cents:   number
  photo_required_vip_channels:  string[]
  auto_ingest_enabled:          boolean
  auto_ingest_sources:          string[]
  default_warehouse_id:         string | null
  settings:                     Record<string, unknown>
}

export const DEFAULT_FULFILLMENT_SETTINGS: Omit<FulfillmentSettings, 'organization_id'> = {
  ai_damage_triage_enabled:     false,
  ai_pack_verification_enabled: false,
  ai_smart_queue_enabled:       false,
  photo_required_always:        false,
  photo_required_above_cents:   15000,
  photo_required_vip_channels:  [],
  auto_ingest_enabled:          false,
  auto_ingest_sources:          ['marketplace', 'storefront'],
  default_warehouse_id:         null,
  settings:                     {},
}
