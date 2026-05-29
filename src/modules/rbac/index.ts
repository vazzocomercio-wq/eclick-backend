// ⚠️ ORDEM IMPORTA: decorator + guard PRIMEIRO. Eles não têm dependência de
// projeto, então carregam limpo. RbacModule (que puxa AccessModule → ciclos)
// vem por último — assim, se um ciclo reentrar este barrel meio-carregado,
// RequirePermission/Guard já estão atribuídos. (Outage 2026-05-29: whatsapp
// crashou com 'RequirePermission is not a function' por causa disso.)
export { RequirePermission } from './require-permission.decorator'
export { RequirePermissionGuard } from './require-permission.guard'
export { PermissionService } from './permission.service'
export { RbacAdminService } from './rbac-admin.service'
export { RbacModule } from './rbac.module'
