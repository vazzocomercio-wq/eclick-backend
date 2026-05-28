import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { AccessService } from '../access/access.service'
import { RbacAdminService } from './rbac-admin.service'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * F17-B6 · Endpoints admin de RBAC. Apenas platform admin
 * (vazzocomercio@gmail.com) acessa. Todos os endpoints recebem `orgId`
 * em query ou body; se omitido, usa `reqUser.orgId` (Vazzo na sessão).
 */
@Controller('access/admin/rbac')
@UseGuards(SupabaseAuthGuard)
export class RbacAdminController {
  constructor(
    private readonly access: AccessService,
    private readonly svc:    RbacAdminService,
  ) {}

  // ─── Catálogo (read-only) ───────────────────────────────────────────────

  /** GET /access/admin/rbac/permissions — catálogo global de permissions */
  @Get('permissions')
  async permissions(@ReqUser() u: ReqUserPayload) {
    await this.access.assertPlatformAdmin(u.id)
    return this.svc.listPermissions()
  }

  /** GET /access/admin/rbac/roles?orgId=... — templates + custom da org */
  @Get('roles')
  async roles(
    @ReqUser() u: ReqUserPayload,
    @Query('orgId') orgIdQuery?: string,
  ) {
    await this.access.assertPlatformAdmin(u.id)
    const orgId = orgIdQuery ?? u.orgId
    if (!orgId) throw new BadRequestException('orgId obrigatório.')
    return this.svc.listRoles(orgId)
  }

  /** GET /access/admin/rbac/roles/:id — detalhes + permission_keys */
  @Get('roles/:id')
  async roleDetail(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    await this.access.assertPlatformAdmin(u.id)
    return this.svc.getRoleDetail(id)
  }

  /** GET /access/admin/rbac/users?orgId=... — users da org + roles atuais */
  @Get('users')
  async users(
    @ReqUser() u: ReqUserPayload,
    @Query('orgId') orgIdQuery?: string,
  ) {
    await this.access.assertPlatformAdmin(u.id)
    const orgId = orgIdQuery ?? u.orgId
    if (!orgId) throw new BadRequestException('orgId obrigatório.')
    return this.svc.listUsersWithRoles(orgId)
  }

  // ─── Roles CRUD ─────────────────────────────────────────────────────────

  /** POST /access/admin/rbac/roles — cria custom role
   *  body: { orgId?, key, name, description?, baseTemplateKey? } */
  @Post('roles')
  async createRole(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      orgId?:            string
      key?:              string
      name?:             string
      description?:      string
      baseTemplateKey?:  string
    },
  ) {
    await this.access.assertPlatformAdmin(u.id)
    const orgId = body.orgId ?? u.orgId
    if (!orgId)     throw new BadRequestException('orgId obrigatório.')
    if (!body.key)  throw new BadRequestException('key obrigatória.')
    if (!body.name) throw new BadRequestException('name obrigatório.')
    return this.svc.createCustomRole({
      orgId,
      key:             body.key,
      name:            body.name,
      description:     body.description,
      baseTemplateKey: body.baseTemplateKey,
    })
  }

  /** PUT /access/admin/rbac/roles/:id
   *  body: { name?, description?, permissionKeys?: string[] } */
  @Put('roles/:id')
  async updateRole(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string; permissionKeys?: string[] },
  ) {
    await this.access.assertPlatformAdmin(u.id)
    return this.svc.updateRole(id, body)
  }

  /** DELETE /access/admin/rbac/roles/:id */
  @Delete('roles/:id')
  async deleteRole(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    await this.access.assertPlatformAdmin(u.id)
    return this.svc.deleteRole(id)
  }

  // ─── Atribuição ─────────────────────────────────────────────────────────

  /** POST /access/admin/rbac/users/:userId/roles
   *  body: { orgId?, roleKey } */
  @Post('users/:userId/roles')
  async assignRole(
    @ReqUser() u: ReqUserPayload,
    @Param('userId') userId: string,
    @Body() body: { orgId?: string; roleKey?: string },
  ) {
    await this.access.assertPlatformAdmin(u.id)
    const orgId = body.orgId ?? u.orgId
    if (!orgId)         throw new BadRequestException('orgId obrigatório.')
    if (!body.roleKey)  throw new BadRequestException('roleKey obrigatório.')
    return this.svc.assignRoleToUser({
      userId, orgId, roleKey: body.roleKey, grantedBy: u.id,
    })
  }

  /** DELETE /access/admin/rbac/users/:userId/roles/:roleId?orgId=... */
  @Delete('users/:userId/roles/:roleId')
  async revokeRole(
    @ReqUser() u: ReqUserPayload,
    @Param('userId') userId: string,
    @Param('roleId') roleId: string,
    @Query('orgId') orgIdQuery?: string,
  ) {
    await this.access.assertPlatformAdmin(u.id)
    const orgId = orgIdQuery ?? u.orgId
    if (!orgId) throw new BadRequestException('orgId obrigatório.')
    return this.svc.revokeRoleFromUser({ userId, orgId, roleId })
  }
}
