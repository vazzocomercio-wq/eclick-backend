/**
 * F6 Sprint 2 — body para PATCH /creative/prompt-templates/:id.
 *
 * Codebase não tem class-validator/@nestjs/mapped-types — usar Partial<T>
 * nativo. Service aplica somente campos definidos (undefined ignorados).
 */

import type { CreatePromptTemplateDto } from './create-prompt-template.dto'

export type UpdatePromptTemplateDto = Partial<CreatePromptTemplateDto>
