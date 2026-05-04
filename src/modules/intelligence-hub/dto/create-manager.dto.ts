export type ManagerDepartment =
  | 'compras' | 'comercial' | 'marketing' | 'logistica' | 'diretoria'

export interface CreateManagerDto {
  name: string
  phone: string
  department: ManagerDepartment
  role?: string | null
  channel_id?: string | null
  preferences?: Record<string, unknown>
}
