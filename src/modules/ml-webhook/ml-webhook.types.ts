// Shape do payload de notificação do ML
// https://developers.mercadolibre.com.br/pt_br/notificacoes-de-atualizacao

export interface MlWebhookPayload {
  _id?:              string
  resource:          string
  user_id:           number
  topic:             string
  application_id?:   number
  attempts?:         number
  sent?:             string
  received?:         string
  actions?:          string[]
}
