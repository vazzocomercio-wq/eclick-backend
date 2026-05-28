import { SetMetadata } from '@nestjs/common'

export const REQUIRE_PERMISSION_KEY = 'rbac:require_permission'

/**
 * Marca um handler/controller exigindo uma (ou várias, AND) permission keys.
 * Combine sempre com `@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)`.
 *
 * Múltiplas keys = todas necessárias (AND). Pra OR, use o decorator novamente
 * em outra camada ou faça checagem inline com PermissionService.
 *
 * Ex:
 *   @UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
 *   @RequirePermission('products.publish_ml')
 *   @Post('/publish')
 *   publish() { ... }
 */
export const RequirePermission = (...keys: string[]) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, keys)
