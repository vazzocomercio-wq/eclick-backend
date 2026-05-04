import type { ManagerDepartment } from './create-manager.dto'

export type Analyzer =
  | 'compras' | 'preco' | 'estoque' | 'margem' | 'ads' | 'cross_intel' | '*'

export interface CreateRoutingRuleDto {
  department: ManagerDepartment
  analyzer: Analyzer
  categories?: string[]
  min_score?: number
  enabled?: boolean
}

export interface UpdateRoutingRuleDto {
  department?: ManagerDepartment
  analyzer?: Analyzer
  categories?: string[]
  min_score?: number
  enabled?: boolean
}
