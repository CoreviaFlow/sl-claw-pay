// sl-claw-pay — минимальный бэкенд оплаты Monobank Acquiring для кнопок сайта.
// Токен Monobank живёт ТОЛЬКО здесь (env), в браузер не попадает.
const http = require('http');

const TOKEN = process.env.MONOBANK_TOKEN || '';
const BASE  = process.env.BASE_URL  || 'https://pay.sl-claw.tech';
const SITE  = process.env.SITE_URL  || 'https://sl-claw.tech';
// Цены по тарифам в ГРИВНАХ (гипотеза — поменять под реальные). UAH.
const PRICES = {
  lite: +(process.env.PRICE_LITE || 3990),
  std:  +(process.env.PRICE_STD  || 7990),
  pro:  +(process.env.PRICE_PRO  || 15990),
};
const ALIAS = { Lite:'lite', Standard:'std', Std:'std', Pro:'pro', lite:'lite', std:'std', pro:'pro' };

const page = (b) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">`
  + `<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#0b0d10;line-height:1.6">${b}</body>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  const H = { 'content-type': 'text/html; charset=utf-8' };

  if (u.pathname === '/health') { res.writeHead(200); return res.end('ok'); }

  if (u.pathname === '/success') {
    res.writeHead(200, H);
    return res.end(page(`<h2>Оплата принята ✅</h2><p>Спасибо! Мы свяжемся с вами и выдадим доступ к репозиторию бота и токен.</p><p><a href="${SITE}/catalog.html">← в каталог</a></p>`));
  }

  if (u.pathname === '/webhook') {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { console.log('MONO WEBHOOK:', b.slice(0, 600)); res.writeHead(200); res.end('ok'); });
    return;
  }

  if (u.pathname === '/create') {
    const niche = (u.searchParams.get('niche') || 'bot').replace(/[^a-z0-9-]/gi, '').slice(0, 60);
    const tier  = ALIAS[u.searchParams.get('tier')] || 'std';
    const amount = (PRICES[tier] || PRICES.std) * 100; // копейки
    if (!TOKEN) { res.writeHead(500, H); return res.end(page('<h2>Оплата не настроена</h2><p>MONOBANK_TOKEN не задан.</p>')); }
    try {
      const r = await fetch('https://api.monobank.ua/api/merchant/invoice/create', {
        method: 'POST',
        headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount, ccy: 980,
          merchantPaymInfo: { reference: `bot-${niche}-${Date.now()}`, destination: `SL-CLAW: AI-продавец (ниша ${niche}, тариф ${tier})` },
          redirectUrl: `${BASE}/success`,
          webHookUrl: `${BASE}/webhook`,
        }),
      });
      const d = await r.json();
      if (d.pageUrl) { res.writeHead(302, { Location: d.pageUrl }); return res.end(); }
      res.writeHead(502, H); return res.end(page('<h2>Не удалось создать счёт</h2><pre>' + JSON.stringify(d) + '</pre>'));
    } catch (e) {
      res.writeHead(502, H); return res.end(page('<h2>Ошибка оплаты</h2><pre>' + e.message + '</pre>'));
    }
  }

  res.writeHead(302, { Location: SITE }); res.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('sl-claw-pay on', PORT));
