import {
  BadRequestException, Body, Controller, Get, Param, Put, UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
// Imports dos arquivos concretos (não do barrel '../rbac') — regra preventiva
// do outage pós-Wave-16: módulos no grafo do AccessModule entram em ciclo via
// barrel. Este controller mora no próprio RbacModule, mesma precaução.
import { RequirePermission } from './require-permission.decorator'
import { RequirePermissionGuard } from './require-permission.guard'
import { AccountScopeService, AccountScopeRow } from './account-scope.service'
import { supabaseAdmin } from '../../common/supabase'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * F17-C · Gestão do escopo por conta (operador responsável por conta).
 * Org-level (não platform admin): owner/admin da org gerencia via tela Equipe.
 *
 *   GET /access/account-scopes/options        — contas conectadas da org (picker)
 *   GET /access/account-scopes/users/:userId  — escopo atual de um membro
 *   PUT /access/account-scopes/users/:userId  — substitui o escopo (replace-all)
 */
@Controller('access/account-scopes')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class AccountScopeController {
  constructor(private readonly scopes: AccountScopeService) {}

  @Get('options')
  @RequirePermission('team.view')
  async options(@ReqUser() u: ReqUserPayload) {
    return { accounts: await this.scopes.listOrgAccountOptions(u.orgId!) }
  }

  @Get('users/:userId')
  @RequirePermission('team.view')
  async forUser(@ReqUser() u: ReqUserPayload, @Param('userId') userId: string) {
    await this.assertMemberOfOrg(u.orgId!, userId)
    return { scopes: await this.scopes.listForUser(u.orgId!, userId) }
  }

  @Put('users/:userId')
  @RequirePermission('team.manage_roles')
  async replace(
    @ReqUser() u: ReqUserPayload,
    @Param('userId') userId: string,
    @Body() body: { scopes?: Array<{ platform?: string; account_key?: string; account_label?: string | null }> },
  ) {
    await this.assertMemberOfOrg(u.orgId!, userId)

    const wanted = Array.isArray(body?.scopes) ? body.scopes : []
    // Valida contra as contas REAIS da org — evita typo e evita atribuir
    // conta de outra org.
    const options = await this.scopes.listOrgAccountOptions(u.orgId!)
    const valid = new Map(options.map(o => [`${o.platform}::${o.account_key}`, o]))

    const clean: AccountScopeRow[] = []
    const seen = new Set<string>()
    for (const s of wanted) {
      const key = `${s.platform}::${s.account_key}`
      const opt = valid.get(key)
      if (!opt) {
        throw new BadRequestException(
          `Conta inválida: ${s.platform}/${s.account_key} não é uma conta conectada desta organização.`,
        )
      }
      if (seen.has(key)) continue
      seen.add(key)
      clean.push({
        platform:      opt.platform,
        account_key:   opt.account_key,
        account_label: s.account_label ?? opt.account_label,
      })
    }

    return this.scopes.replaceForUser(u.orgId!, userId, clean, u.id)
  }

  /** Garante que o alvo é membro da MESMA org do solicitante. */
  private async assertMemberOfOrg(orgId: string, userId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new BadRequestException('Usuário não é membro desta organização.')
  }
}
