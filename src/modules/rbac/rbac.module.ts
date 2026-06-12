import { forwardRef, Global, Module } from '@nestjs/common'
import { PermissionService } from './permission.service'
import { RequirePermissionGuard } from './require-permission.guard'
import { RbacAdminService } from './rbac-admin.service'
import { RbacAdminController } from './rbac-admin.controller'
import { AccountScopeService } from './account-scope.service'
import { AccountScopeController } from './account-scope.controller'
import { AccessModule } from '../access/access.module'

/**
 * F17-B · Módulo central de RBAC. `@Global` pra qualquer feature module
 * conseguir injetar `PermissionService` e `RequirePermissionGuard` sem
 * precisar importar `RbacModule` toda vez.
 *
 * Endpoint user-facing `/access/me/permissions` mora no `AccessMeController`.
 * Endpoints admin (`/access/admin/rbac/*`) moram aqui via `RbacAdminController`
 * — reusam `AccessService.assertPlatformAdmin` (forwardRef pra evitar ciclo).
 */
@Global()
@Module({
  imports:     [forwardRef(() => AccessModule)],
  controllers: [RbacAdminController, AccountScopeController],
  providers:   [PermissionService, RequirePermissionGuard, RbacAdminService, AccountScopeService],
  exports:     [PermissionService, RequirePermissionGuard, RbacAdminService, AccountScopeService],
})
export class RbacModule {}
