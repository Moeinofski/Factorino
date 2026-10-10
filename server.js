'use strict';

// Minimal license/order API. It never accepts customer, product, invoice, or payment-detail data.
// Payment initiation requires a provider adapter; order/licensing APIs never touch business records.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.FACTORINO_DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'licenses.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, recovery_code_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','failed')), provider_reference TEXT, checkout_url TEXT,
  created_at TEXT NOT NULL, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, order_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);`);

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const PRICE = Number(process.env.PRO_PRICE_MINOR || 1990000);
const signingSecret = process.env.LICENSE_SIGNING_SECRET || '';
const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || '';
const adapterPath = process.env.PAYMENT_ADAPTER_MODULE || '';
const paymentAdapter = adapterPath ? require(path.resolve(ROOT, adapterPath)) : null;
const publicAppUrl = process.env.PUBLIC_APP_URL || '';
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8', '.svg':'image/svg+xml' };
const limitMap = new Map();

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(data), 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
  res.end(data);
}
function fail(res, code, message) { json(res, code, { error: message }); }
function allowed(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) { fail(res, 403, 'مبدأ درخواست مجاز نیست.'); return false; }
  return true;
}
function rateLimit(req, res, bucket, max = 12) {
  const key = `${bucket}:${req.socket.remoteAddress || 'unknown'}`, now = Date.now(), previous = limitMap.get(key) || { count:0, since:now };
  if (now - previous.since > 60000) { previous.count = 0; previous.since = now; }
  previous.count++; limitMap.set(key, previous);
  if (previous.count > max) { fail(res, 429, 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.'); return false; }
  return true;
}
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16000) throw Object.assign(new Error('درخواست بیش از اندازه بزرگ است.'), { status:413 }); }
  try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('ساختار درخواست معتبر نیست.'), { status:400 }); }
}
async function rawBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>16000) throw Object.assign(new Error('درخواست بیش از اندازه بزرگ است.'),{status:413}); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function sign(payload) {
  if (signingSecret.length < 32) throw new Error('LICENSE_SIGNING_SECRET must contain at least 32 characters.');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${crypto.createHmac('sha256', signingSecret).update(encoded).digest('base64url')}`;
}
function verify(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [encoded, signature, extra] = token.split('.'); if (!encoded || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', signingSecret).update(encoded).digest();
  let actual; try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let payload; try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { return null; }
  return (!payload.exp || payload.exp > Date.now()) && payload.product === 'factorino-pro' ? payload : null;
}
function issueLicense(order, installationId = order.installation_id) {
  const now = new Date().toISOString(), id = crypto.randomUUID();
  const token = sign({ iss:'factorino-license', product:'factorino-pro', sub:installationId, orderId:order.id, iat:Date.now() });
  db.prepare('INSERT INTO licenses(id,installation_id,order_id,token_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET installation_id=excluded.installation_id,token_hash=excluded.token_hash,created_at=excluded.created_at').run(id,installationId,order.id,hash(token),now);
  return { token, activatedAt:now, licenseId:id };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return staticFile(url.pathname, res);
  if (!allowed(req,res)) return;
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res,200,{ ok:true, service:'factorino-license' });

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    if (!rateLimit(req,res,'orders',5)) return;
    if (!paymentAdapter || typeof paymentAdapter.createCheckout !== 'function' || typeof paymentAdapter.verifyWebhook !== 'function' || !webhookSecret || !publicAppUrl) return fail(res,503,'درگاه پرداخت هنوز پیکربندی نشده است.');
    let appOrigin; try { appOrigin = new URL(publicAppUrl); } catch { return fail(res,503,'نشانی عمومی برنامه معتبر نیست.'); }
    if (appOrigin.protocol !== 'https:') return fail(res,503,'نشانی عمومی برنامه باید HTTPS باشد.');
    if (signingSecret.length < 32) return fail(res,503,'کلید امضای مجوز باید دست‌کم ۳۲ نویسه باشد.');
    let input; try { input = await body(req); } catch (e) { return fail(res,e.status||400,e.message); }
    const installationId=String(input.installationId||''), idempotencyKey=String(req.headers['idempotency-key']||'');
    if (!/^[a-zA-Z0-9_-]{12,128}$/.test(installationId)||!/^[a-zA-Z0-9_-]{12,128}$/.test(idempotencyKey)) return fail(res,400,'شناسه نصب یا کلید یکتای سفارش معتبر نیست.');
    const recoveryCode=crypto.createHmac('sha256',signingSecret).update(`recovery:${installationId}:${idempotencyKey}`).digest('base64url');
    let order=db.prepare('SELECT * FROM orders WHERE idempotency_key=?').get(idempotencyKey);
    if(order&&order.installation_id!==installationId)return fail(res,409,'کلید سفارش قبلاً برای نصب دیگری استفاده شده است.');
    if(order?.status==='paid')return fail(res,409,'این سفارش قبلاً پرداخت شده است.');
    if(order?.status==='pending'&&order.checkout_url)return json(res,200,{orderId:order.id,status:order.status,checkoutUrl:order.checkout_url,recoveryCode});
    let orderId;
    if(order){orderId=order.id;db.prepare("UPDATE orders SET status='pending',checkout_url=NULL WHERE id=?").run(orderId);}
    else {orderId=crypto.randomUUID();const createdAt=new Date().toISOString();db.prepare('INSERT INTO orders(id,installation_id,recovery_code_hash,idempotency_key,amount,currency,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(orderId,installationId,hash(recoveryCode),idempotencyKey,PRICE,'IRR','pending',createdAt);order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);}
    try{
      const callback=new URL('/',publicAppUrl);callback.searchParams.set('payment_order',orderId);
      const checkout=await paymentAdapter.createCheckout({orderId,amount:PRICE,currency:'IRR',description:'Factorino Pro · یک خرید',callbackUrl:callback.href});
      const checkoutUrl=new URL(checkout.checkoutUrl);
      if(checkoutUrl.protocol!=='https:'&&!(checkoutUrl.protocol==='http:'&&['localhost','127.0.0.1'].includes(checkoutUrl.hostname)))throw new Error('Payment checkout must use HTTPS');
      db.prepare('UPDATE orders SET provider_reference=?,checkout_url=? WHERE id=?').run(String(checkout.reference||'').slice(0,200),checkoutUrl.href,orderId);
      return json(res,201,{orderId,status:'pending',checkoutUrl:checkoutUrl.href,recoveryCode});
    }catch(error){db.prepare("UPDATE orders SET status='failed' WHERE id=? AND status='pending'").run(orderId);console.error('Payment adapter could not create checkout:',error.message);return fail(res,502,'ساخت صفحه پرداخت انجام نشد؛ دوباره تلاش کنید.');}
  }
  if (req.method === 'POST' && url.pathname === '/api/payment/webhook') {
    if (!paymentAdapter || typeof paymentAdapter.verifyWebhook !== 'function' || !rateLimit(req,res,'webhook',60)) return fail(res,503,'دریافت تأیید پرداخت در دسترس نیست.');
    let raw,input; try { raw=await rawBody(req); input=JSON.parse(raw.toString('utf8')||'{}'); } catch (e) { return fail(res,e.status||400,'ساختار درخواست معتبر نیست.'); }
    let event; try { event=paymentAdapter.verifyWebhook({rawBody:raw,signature:String(req.headers['x-webhook-signature']||''),secret:webhookSecret}); } catch { return fail(res,401,'امضای وب‌هوک معتبر نیست.'); }
    if(!event || event.status!=='paid' || input.event!=='payment.paid')return fail(res,400,'رویداد پرداخت معتبر نیست.');
    const order = db.prepare('SELECT * FROM orders WHERE provider_reference=?').get(String(event.reference||''));
    if (!order) return fail(res,404,'سفارش پیدا نشد.');
    if (Number(event.amount) !== order.amount) return fail(res,400,'مبلغ پرداخت با سفارش مطابقت ندارد.');
    if(order.status==='failed')return fail(res,409,'وضعیت سفارش اجازه تأیید پرداخت نمی‌دهد.');
    if(order.status!=='paid')db.prepare("UPDATE orders SET status='paid',paid_at=? WHERE id=?").run(new Date().toISOString(),order.id);
    issueLicense(order);
    return json(res,200,{ ok:true });
  }

  const orderMatch=url.pathname.match(/^\/api\/orders\/([a-f0-9-]+)$/i);
  if(req.method==='GET'&&orderMatch){
    if(!rateLimit(req,res,'order-status',20))return;
    const installationId=String(url.searchParams.get('installationId')||''),order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderMatch[1]);
    if(!order||order.installation_id!==installationId)return fail(res,404,'سفارش پیدا نشد.');
    if(order.status!=='paid')return json(res,200,{status:order.status});
    const license=issueLicense(order,installationId);return json(res,200,{status:'paid',...license});
  }

  if (req.method === 'POST' && url.pathname === '/api/licenses/verify') {
    if (!rateLimit(req,res,'verify',30)) return;
    let input; try { input = await body(req); } catch (e) { return fail(res,e.status||400,e.message); }
    const payload = verify(input.token);
    return json(res,200,{ valid:!!payload && payload.sub===input.installationId, product:payload?'factorino-pro':null });
  }

  if (req.method === 'POST' && url.pathname === '/api/licenses/recover') {
    if (!rateLimit(req,res,'recover',5)) return;
    let input; try { input = await body(req); } catch (e) { return fail(res,e.status||400,e.message); }
    const recoveryCode = String(input.recoveryCode || ''), installationId = String(input.installationId || '');
    if (!/^[a-zA-Z0-9_-]{12,128}$/.test(installationId) || recoveryCode.length < 20 || recoveryCode.length > 128) return fail(res,400,'اطلاعات بازیابی معتبر نیست.');
    const order = db.prepare("SELECT * FROM orders WHERE recovery_code_hash=? AND status='paid'").get(hash(recoveryCode));
    if (!order) return fail(res,404,'خرید تأییدشده‌ای با این کد پیدا نشد.');
    if (signingSecret.length < 32) return fail(res,503,'سرویس مجوز پیکربندی نشده است.');
    return json(res,200,{ ...issueLicense(order,installationId), status:'active' });
  }
  return fail(res,404,'مسیر پیدا نشد.');
}

function staticFile(requestPath,res) {
  let pathname; try { pathname = decodeURIComponent(requestPath); } catch { return fail(res,400,'مسیر نامعتبر است.'); }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(ROOT + path.sep) || file.startsWith(DATA_DIR + path.sep)) return fail(res,403,'دسترسی مجاز نیست.');
  fs.stat(file,(error,stat)=>{
    if (error || !stat.isFile()) return fail(res,404,'صفحه پیدا نشد.');
    res.writeHead(200,{ 'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':path.basename(file)==='service-worker.js'?'no-cache':'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req,res)=>{ route(req,res).catch(error=>{ console.error('Request failed:',error.message); if(!res.headersSent) fail(res,500,'خطای داخلی سرویس.'); else res.destroy(); }); }).listen(PORT,HOST,()=>console.log(`Factorino running on http://${HOST}:${PORT}`));

