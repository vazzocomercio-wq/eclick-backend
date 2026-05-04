import type { ManagerDepartment } from './create-manager.dto'

export interface UpdateManagerDto {
  name?: string
  phone?: string
  department?: ManagerDepartment
  role?: string | null
  channel_id?: string | null
  status?: 'pending' | 'active' | 'paused' | 'inactive'
  preferences?: Record<string, unknown>
}
