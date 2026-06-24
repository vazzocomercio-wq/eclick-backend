# e-Click Farm Agent

Programa que roda **na rede local da fábrica** (no PC que fica ligado), lê o
estado das impressoras Bambu via MQTT e envia pro e-Click Product OS. A nuvem
não alcança a rede local — por isso esse agente fica no meio.

## 1. Preparar a impressora (uma vez por máquina)

Na tela da impressora: **Configurações → mais → LAN Only / Developer Mode**.
Anote os 3 dados (na tela de rede da impressora):

- **Serial** (nº de série, começa com `01P...`)
- **IP** na rede (ex.: `192.168.1.50`) — recomendo fixar o IP no roteador
- **Access Code** (código de acesso de 8 dígitos)

> Para só **monitorar**, o modo LAN com Access Code basta. Para **enviar
> impressão** (fase seguinte), é preciso o Developer Mode ligado.

## 2. Gerar o token do agente

No e-Click: **Catálogo → Product OS → Impressoras → Conectar farm** → "Novo
agente" → copie o **token** (aparece uma vez só).

## 3. Configurar

1. Instale o Node.js 18+ (https://nodejs.org) no PC que fica ligado.
2. Nesta pasta, copie `config.example.json` para `config.json` e preencha:
   - `agent_token`: o token copiado do e-Click
   - `printers`: uma entrada por impressora (name, serial, ip, access_code)
3. Instale as dependências e rode:

```bash
npm install
npm start
```

Deve aparecer `[Bambu A1 #1] conectado` e, no e-Click, a impressora fica
**online** com o estado ao vivo.

## 4. Deixar rodando sempre (Windows)

Para o agente subir sozinho e ficar de pé:

- **Opção simples:** Agendador de Tarefas do Windows → nova tarefa → "Ao
  iniciar o computador" → ação: `node` com argumento `agent.mjs` (na pasta).
- **Opção robusta:** instale o [pm2](https://pm2.keymetrics.io):
  `npm i -g pm2 && pm2 start agent.mjs --name eclick-farm && pm2 save`.

## Segurança

- O agente só faz conexões **de saída** (não abre porta na sua rede).
- Os códigos de acesso das impressoras ficam **só no `config.json` local**.
- O `token` autentica o envio; se vazar, revogue no e-Click e gere outro.
