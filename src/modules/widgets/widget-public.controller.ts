import { Controller, Get, Param, Res } from '@nestjs/common'
import type { Response } from 'express'
import { ChatWidgetService } from './chat-widget.service'

@Controller()
export class WidgetPublicController {
  constructor(private readonly svc: ChatWidgetService) {}

  /**
   * Embeddable script. Loaded via:
   *   <script async src="https://api/widget.js"></script>
   * Reads window.EClickWidget.{token, position, color} and injects a
   * floating button + chat iframe.
   */
  @Get('widget.js')
  serveScript(@Res() res: Response) {
    const backendUrl = process.env.PUBLIC_BACKEND_URL ?? ''

    const js = `(function () {
  var cfg = window.EClickWidget || {};
  var token = cfg.token;
  if (!token) { console.warn('[eclick-widget] missing window.EClickWidget.token'); return; }

  var position = cfg.position || 'bottom-right';
  var color    = cfg.color    || '#00E5FF';
  var BACKEND  = ${JSON.stringify(backendUrl)};
  var SESS_KEY = 'eclick_session_' + token;
  var sessionToken = null;
  try { sessionToken = localStorage.getItem(SESS_KEY); } catch (e) {}

  // Floating button
  var btn = document.createElement('div');
  var sideStyle = position.indexOf('right') !== -1 ? 'right: 24px;' : 'left: 24px;';
  btn.setAttribute('aria-label', 'Abrir chat');
  btn.style.cssText =
    'position:fixed;' + sideStyle + 'bottom:24px;' +
    'width:56px;height:56px;background:' + color + ';' +
    'border-radius:50%;cursor:pointer;z-index:2147483646;' +
    'box-shadow:0 4px 20px rgba(0,229,255,0.4);' +
    'display:flex;align-items:center;justify-content:center;' +
    'transition:transform 0.2s;';
  btn.innerHTML =
    '<svg width="28" height="28" viewBox="0 0 28 28" fill="white">' +
    '<path d="M14 2C7.37 2 2 7.37 2 14c0 2.1.54 4.07 1.5 5.77L2 26l6.4-1.65A11.93 11.93 0 0014 26c6.63 0 12-5.37 12-12S20.63 2 14 2z"/></svg>';
  document.body.appendChild(btn);

  var iframe = null;
  var open = false;

  btn.onclick = function () {
    open = !open;
    if (!iframe) {
      iframe = document.createElement('iframe');
      var src = BACKEND + '/widget-ui/' + encodeURIComponent(token);
      if (sessionToken) src += '?session=' + encodeURIComponent(sessionToken);
      iframe.src = src;
      iframe.title = 'Chat eClick';
      iframe.style.cssText =
        'position:fixed;' + sideStyle + 'bottom:92px;' +
        'width:360px;height:520px;border:none;' +
        'border-radius:16px;z-index:2147483645;' +
        'box-shadow:0 8px 40px rgba(0,0,0,0.2);' +
        'opacity:0;pointer-events:none;transition:opacity 0.2s;';
      document.body.appendChild(iframe);

      window.addEventListener('message', function (e) {
        if (!e.data) return;
        if (e.data.type === 'eclick_session' && e.data.token) {
          sessionToken = e.data.token;
          try { localStorage.setItem(SESS_KEY, sessionToken); } catch (err) {}
        }
        if (e.data.type === 'eclick_close') {
          open = false;
          iframe.style.opacity = '0';
          iframe.style.pointerEvents = 'none';
          btn.style.transform = 'scale(1)';
        }
      });
    }
    iframe.style.opacity = open ? '1' : '0';
    iframe.style.pointerEvents = open ? 'auto' : 'none';
    btn.style.transform = open ? 'rotate(45deg) scale(0.9)' : 'scale(1)';
  };
})();`

    res.setHeader('Content-Type',  'application/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.status(200).send(js)
  }

  /**
   * Iframe HTML for the chat UI. Renders a minimal vanilla chat widget that
   * POSTs to /webhooks/widget/:token. Public — anyone with the widget token
   * can load.
   */
  @Get('widget-ui/:token')
  async serveUi(@Param('token') token: string, @Res() res: Response) {
    const widget = await this.svc.findByToken(token)
    if (!widget) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.status(404).send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:24px;color:#888">Widget não encontrado.</body>')
    }

    const backendUrl = process.env.PUBLIC_BACKEND_URL ?? ''
    const safeColor   = JSON.stringify(widget.theme_color)
    const safeWelcome = JSON.stringify(widget.welcome_message)
    const safePh      = JSON.stringify(widget.placeholder_text)
    const safeName    = JSON.stringify(widget.name)
    const safeToken   = JSON.stringify(widget.widget_token)
    const safeBackend = JSON.stringify(backendUrl)
    const reqName     = widget.require_name  ? 'true' : 'false'
    const reqEmail    = widget.require_email ? 'true' : 'false'
    const reqPhone    = widget.require_phone ? 'true' : 'false'

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #09090b; color: #e4e4e7; overflow: hidden; }
  .h { padding: 14px 16px; border-bottom: 1px solid #1e1e24; display: flex; align-items: center; justify-content: space-between; }
  .h .title { font-size: 13px; font-weight: 600; }
  .h .close { background: none; border: none; color: #71717a; cursor: pointer; font-size: 18px; line-height: 1; }
  .body { height: calc(100vh - 110px); overflow-y: auto; padding: 16px; }
  .form { padding: 16px; }
  .form label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; margin: 8px 0 4px; }
  .form input { width: 100%; padding: 9px 10px; background: #0d0d10; border: 1px solid #27272a; color: #fff; border-radius: 8px; font-size: 13px; outline: none; }
  .form input:focus { border-color: var(--c, #00E5FF); }
  .start { margin-top: 14px; width: 100%; padding: 10px; background: var(--c, #00E5FF); color: #000; border: none; border-radius: 10px; font-weight: 600; cursor: pointer; }
  .msg { display: flex; margin-bottom: 10px; }
  .msg.me  { justify-content: flex-end; }
  .bubble { max-width: 78%; padding: 9px 12px; border-radius: 14px; font-size: 13px; line-height: 1.4; }
  .msg.me .bubble  { background: var(--c, #00E5FF); color: #000; border-bottom-right-radius: 4px; }
  .msg.bot .bubble { background: #1e1e24; color: #e4e4e7; border-bottom-left-radius: 4px; }
  .footer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #1e1e24; }
  .footer input { flex: 1; padding: 9px 10px; background: #0d0d10; border: 1px solid #27272a; color: #fff; border-radius: 8px; font-size: 13px; outline: none; }
  .footer button { padding: 0 14px; background: var(--c, #00E5FF); color: #000; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; }
  .footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body style="--c:${widget.theme_color}">
<div class="h">
  <div class="title">${escapeHtml(widget.name)}</div>
  <button class="close" id="closeBtn" aria-label="Fechar">×</button>
</div>
<div id="formWrap"></div>
<div id="chatBody" class="body" style="display:none"></div>
<div id="chatFooter" class="footer" style="display:none">
  <input id="inp" type="text" placeholder=${safePh} />
  <button id="send">Enviar</button>
</div>
<script>
(function () {
  var BACKEND     = ${safeBackend};
  var TOKEN       = ${safeToken};
  var WELCOME     = ${safeWelcome};
  var REQ_NAME    = ${reqName};
  var REQ_EMAIL   = ${reqEmail};
  var REQ_PHONE   = ${reqPhone};
  var sessionToken = null;
  try { var qp = new URL(location.href).searchParams.get('session'); if (qp) sessionToken = qp; } catch(e){}
  var visitor = { name: '', email: '', phone: '' };

  var formWrap   = document.getElementById('formWrap');
  var chatBody   = document.getElementById('chatBody');
  var chatFooter = document.getElementById('chatFooter');
  var inp        = document.getElementById('inp');
  var sendBtn    = document.getElementById('send');
  var closeBtn   = document.getElementById('closeBtn');

  closeBtn.onclick = function () {
    parent.postMessage({ type: 'eclick_close' }, '*');
  };

  function bubble(role, text) {
    var d = document.createElement('div');
    d.className = 'msg ' + (role === 'me' ? 'me' : 'bot');
    var b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    d.appendChild(b);
    chatBody.appendChild(d);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  function startChat() {
    formWrap.style.display = 'none';
    chatBody.style.display = 'block';
    chatFooter.style.display = 'flex';
    if (WELCOME) bubble('bot', WELCOME);
    inp.focus();
  }

  function send() {
    var text = (inp.value || '').trim();
    if (!text) return;
    bubble('me', text);
    inp.value = '';
    sendBtn.disabled = true;
    fetch(BACKEND + '/webhooks/widget/' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message:       text,
        session_token: sessionToken,
        name:          visitor.name,
        email:         visitor.email,
        phone:         visitor.phone,
        origin_url:    document.referrer
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      sendBtn.disabled = false;
      if (data && data.session_token && !sessionToken) {
        sessionToken = data.session_token;
        try { parent.postMessage({ type: 'eclick_session', token: sessionToken }, '*'); } catch(e){}
      }
      if (data && data.message) bubble('bot', data.message);
      else if (data && data.queued) bubble('bot', '(aguardando atendente humano)');
    }).catch(function () {
      sendBtn.disabled = false;
      bubble('bot', '(erro ao enviar — tente de novo)');
    });
  }

  sendBtn.onclick = send;
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

  // Render visitor form if any field is required
  if (REQ_NAME || REQ_EMAIL || REQ_PHONE) {
    var f = document.createElement('div'); f.className = 'form';
    var html = '';
    if (REQ_NAME)  html += '<label>Nome</label><input id="vName" type="text" />';
    if (REQ_EMAIL) html += '<label>Email</label><input id="vEmail" type="email" />';
    if (REQ_PHONE) html += '<label>Telefone</label><input id="vPhone" type="tel" />';
    html += '<button class="start" id="startBtn">Iniciar conversa</button>';
    f.innerHTML = html;
    formWrap.appendChild(f);
    document.getElementById('startBtn').onclick = function () {
      if (REQ_NAME)  visitor.name  = document.getElementById('vName').value.trim();
      if (REQ_EMAIL) visitor.email = document.getElementById('vEmail').value.trim();
      if (REQ_PHONE) visitor.phone = document.getElementById('vPhone').value.trim();
      if (REQ_NAME && !visitor.name)  return alert('Informe seu nome');
      if (REQ_EMAIL && !visitor.email) return alert('Informe seu email');
      if (REQ_PHONE && !visitor.phone) return alert('Informe seu telefone');
      startChat();
    };
  } else {
    startChat();
  }
})();
</script>
</body></html>`

    res.setHeader('Content-Type',  'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(html)
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
