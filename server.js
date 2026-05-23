// sl-claw-pay — минимальный бэкенд оплаты Monobank Acquiring для кнопок сайта.
// Токен Monobank живёт ТОЛЬКО здесь (env), в браузер не попадает.
// + FB Purchase tracking: server-side CAPI (authoritative) + browser Pixel на /success.
const http = require('http');
const crypto = require('crypto');

const TOKEN = process.env.MONOBANK_TOKEN || '';
// CRM «It цифра» (corevia-crm): лиды с сайта форвардятся сюда с HMAC-подписью.
const CRM_URL = process.env.CRM_WEBHOOK_URL || 'https://crm.coreviaflow.space/api/webhooks/daryna/lead-sync';
const CRM_SECRET = process.env.CRM_WEBHOOK_SECRET || '';
const BASE  = process.env.BASE_URL  || 'https://pay.sl-claw.tech';
const SITE  = process.env.SITE_URL  || 'https://sl-claw.tech';
// FB / CAPI
const CAPI_URL      = process.env.CAPI_URL      || 'https://events.coreviaflow.space/v1/track';
const EVENTS_SECRET = process.env.EVENTS_SECRET || '';
const PIXEL_ID      = process.env.FACEBOOK_PIXEL_ID || '1485718672417519';
// Цены по тарифам в ДОЛЛАРАХ (USD). Счёт выставляется в USD (ccy=840),
// конвертацию в валюту карты делает банк по своему курсу.
const PRICES = {
  lite: +(process.env.PRICE_LITE || 249),
  std:  +(process.env.PRICE_STD  || 449),
  pro:  +(process.env.PRICE_PRO  || 499),
};
const ALIAS = { Lite:'lite', Standard:'std', Std:'std', Pro:'pro', lite:'lite', std:'std', pro:'pro' };

// invoiceId → { fbp, fbc, fbclid, email, amount(USD), niche, tier, ts }
// In-memory (інвойси живуть хвилини; при рестарті in-flight втрачає атрибуцію — допустимо для MVP).
const ORDERS = new Map();
// захист від подвійного Purchase по одному інвойсу
const FIRED = new Set();
function gcOrders() {
  const now = Date.now();
  for (const [k, v] of ORDERS) if (now - v.ts > 2 * 3600 * 1000) ORDERS.delete(k);
}
setInterval(gcOrders, 30 * 60 * 1000).unref?.();

const page = (b) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">`
  + `<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#0b0d10;line-height:1.6">${b}</body>`;

function sha256Lower(v) {
  if (!v) return undefined;
  return require('crypto').createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}

// Server-side Purchase у Meta CAPI (через наш proxy).
async function firePurchaseCAPI(order, invoiceId) {
  if (!EVENTS_SECRET) { console.log('CAPI skip: no EVENTS_SECRET'); return; }
  try {
    const body = {
      event_name: 'Purchase',
      event_id: 'purchase_' + invoiceId,        // дедуп з браузерним Pixel
      event_source_url: `${SITE}/checkout.html`,
      action_source: 'website',
      email: order.email || undefined,
      fbp: order.fbp || undefined,
      fbc: order.fbc || undefined,
      custom_data: {
        value: order.amount,                     // USD
        currency: 'USD',
        content_type: 'product',
        content_ids: [order.niche || order.tier],
        content_category: order.tier,
        order_id: invoiceId,
      },
    };
    const r = await fetch(CAPI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-events-secret': EVENTS_SECRET },
      body: JSON.stringify(body),
    });
    console.log('CAPI Purchase', invoiceId, r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.error('CAPI Purchase error:', e.message); }
}

// Перевірка статусу інвойсу напряму у Monobank — захист від спуфнутого webhook.
async function monoStatus(invoiceId) {
  try {
    const r = await fetch('https://api.monobank.ua/api/merchant/invoice/status?invoiceId=' + encodeURIComponent(invoiceId), {
      headers: { 'X-Token': TOKEN },
    });
    return await r.json();
  } catch (e) { return null; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  const H = { 'content-type': 'text/html; charset=utf-8' };

  if (u.pathname === '/health') { res.writeHead(200); return res.end('ok'); }

  // Лид с сайта (checkout) → CRM «It цифра»
  if (u.pathname === '/lead') {
    res.setHeader('Access-Control-Allow-Origin', SITE);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let b = ''; req.on('data', c => b += c);
    req.on('end', async () => {
      try {
        const lead = JSON.parse(b || '{}');
        const niche = String(lead.niche || '').slice(0, 80);
        const phoneDigits = String(lead.phone || '').replace(/\D/g, '');
        const payload = {
          chat_id: Number(phoneDigits) || Date.now(),   // CRM ключует контакт по chat_id (веб-лид → телефон)
          name: 'Сайт SL-CLAW: ' + (niche || 'заявка'),
          email: String(lead.email || '').slice(0, 160),
          phone: String(lead.phone || '').slice(0, 40),
          tier: String(lead.tier || '').slice(0, 20),
          source: 'website',
          message: `Заявка з checkout sl-claw.tech. Ніша: ${niche}, тариф: ${lead.tier || ''}, ціна: ${lead.price || ''}, мова: ${lead.lang || ''}. URL: ${lead.url || ''}`,
        };
        console.log('LEAD:', JSON.stringify(payload));
        if (CRM_URL && CRM_SECRET) {
          const body = JSON.stringify(payload);
          const sig = crypto.createHmac('sha256', CRM_SECRET).update(body).digest('hex');
          try {
            const r = await fetch(CRM_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Daryna-Signature': sig }, body });
            console.log('LEAD→CRM', r.status);
          } catch (e) { console.log('LEAD→CRM err', e.message); }
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      } catch (e) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":false}'); }
    });
    return;
  }

  if (u.pathname === '/success') {
    // invoiceId з cookie (виставлений у /create) — для браузерного Pixel Purchase з дедупом.
    const cookie = (req.headers.cookie || '').match(/slc_inv=([^;]+)/);
    const invoiceId = cookie ? decodeURIComponent(cookie[1]) : '';
    const order = invoiceId ? ORDERS.get(invoiceId) : null;
    const val = order ? order.amount : 0;
    const eid = invoiceId ? ('purchase_' + invoiceId) : '';
    const pixelSnippet = `
<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${PIXEL_ID}');fbq('track','PageView');
${eid ? `fbq('track','Purchase',{value:${val},currency:'USD'},{eventID:'${eid}'});` : ''}
</script>`;
    res.writeHead(200, H);
    return res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">${pixelSnippet}`
      + `<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#0b0d10;line-height:1.6">`
      + `<h2>Оплата принята ✅</h2><p>Спасибо! Мы свяжемся с вами и выдадим доступ к репозиторию бота и токен.</p><p><a href="${SITE}/catalog.html">← в каталог</a></p></body>`);
  }

  if (u.pathname === '/webhook') {
    let b = ''; req.on('data', c => b += c);
    req.on('end', async () => {
      console.log('MONO WEBHOOK:', b.slice(0, 600));
      res.writeHead(200); res.end('ok');
      // обробляємо асинхронно після відповіді
      try {
        const data = JSON.parse(b || '{}');
        const invoiceId = data.invoiceId;
        if (!invoiceId || FIRED.has(invoiceId)) return;
        // авторитетна перевірка статусу у Monobank
        const st = await monoStatus(invoiceId);
        const status = (st && st.status) || data.status;
        if (status !== 'success') { console.log('webhook status not success:', status); return; }
        FIRED.add(invoiceId);
        const order = ORDERS.get(invoiceId) || {
          amount: st ? (st.amount / 100) : undefined, tier: 'std', niche: 'bot', ts: Date.now(),
        };
        await firePurchaseCAPI(order, invoiceId);
      } catch (e) { console.error('webhook parse error:', e.message); }
    });
    return;
  }

  if (u.pathname === '/create') {
    const niche = (u.searchParams.get('niche') || 'bot').replace(/[^a-z0-9-]/gi, '').slice(0, 60);
    const tier  = ALIAS[u.searchParams.get('tier')] || 'std';
    const amount = (PRICES[tier] || PRICES.std) * 100; // центы USD
    // FB attribution params (з checkout)
    const fbp = (u.searchParams.get('fbp') || '').slice(0, 120);
    const fbc = (u.searchParams.get('fbc') || '').slice(0, 200);
    const fbclid = (u.searchParams.get('fbclid') || '').slice(0, 120);
    const email = (u.searchParams.get('email') || '').slice(0, 160);
    if (!TOKEN) { res.writeHead(500, H); return res.end(page('<h2>Оплата не настроена</h2><p>MONOBANK_TOKEN не задан.</p>')); }
    try {
      const r = await fetch('https://api.monobank.ua/api/merchant/invoice/create', {
        method: 'POST',
        headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount, ccy: 840,
          merchantPaymInfo: { reference: `bot-${niche}-${Date.now()}`, destination: `SL-CLAW: AI-продавец (ниша ${niche}, тариф ${tier})` },
          redirectUrl: `${SITE}/thanks.html`,
          webHookUrl: `${BASE}/webhook`,
        }),
      });
      const d = await r.json();
      if (d.pageUrl) {
        // зберігаємо атрибуцію для server-side Purchase + ставимо cookie для browser Purchase
        if (d.invoiceId) {
          ORDERS.set(d.invoiceId, { fbp, fbc, fbclid, email, amount: amount / 100, niche, tier, ts: Date.now() });
        }
        const headers = { Location: d.pageUrl };
        if (d.invoiceId) headers['Set-Cookie'] = [
          `slc_inv=${encodeURIComponent(d.invoiceId)}; Domain=.sl-claw.tech; Path=/; Max-Age=7200; SameSite=Lax; Secure`,
          `slc_val=${amount / 100}; Domain=.sl-claw.tech; Path=/; Max-Age=7200; SameSite=Lax; Secure`,
        ];
        res.writeHead(302, headers); return res.end();
      }
      res.writeHead(502, H); return res.end(page('<h2>Не удалось создать счёт</h2><pre>' + JSON.stringify(d) + '</pre>'));
    } catch (e) {
      res.writeHead(502, H); return res.end(page('<h2>Ошибка оплаты</h2><pre>' + e.message + '</pre>'));
    }
  }

  res.writeHead(302, { Location: SITE }); res.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('sl-claw-pay on', PORT));
