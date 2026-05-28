import { Global, Module } from '@nestjs/common'
import { PermissionService } from './permission.service'
import { RequirePermissionGuard } from './require-permission.guard'

/**
 * F17-B · Módulo central de RBAC. `@Global` pra qualquer feature module
 * conseguir injetar `PermissionService` e `RequirePermissionGuard` sem
 * precisar importar `RbacModule` toda vez. Sem controllers — endpoints
 * de RBAC user-facing ficam no AccessController (/access/me/permissions).
 */
@Global()
@Module({
  providers: [PermissionService, RequirePermissionGuard],
  exports:   [PermissionService, RequirePermissionGuard],
})
export class RbacModule {}
