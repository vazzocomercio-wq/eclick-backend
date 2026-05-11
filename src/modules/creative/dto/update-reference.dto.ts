/**
 * F6 Sprint 2 — body para PATCH /creative/references/:id.
 *
 * Service aplica só campos definidos.
 */

import type { CreateReferenceDto } from './create-reference.dto'

export type UpdateReferenceDto = Partial<CreateReferenceDto> & {
  is_active?: boolean
}
