require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'events.jsonl');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.APP_PASSWORD || !process.env.SESSION_SECRET || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  console.error('Missing required .env settings. Copy .env.example to .env and configure it on the server.');
  process.exit(1);
}
if (PROD) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'sky_solar_session',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: PROD, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 }
}));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const htmlEscape = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function loginPage(error='') {
  return `<!doctype html><html lang="ku" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Sky Solar Energy - Login</title><style>body{font-family:Arial,sans-serif;background:#f3f6f5;color:#182b28;display:grid;min-height:100vh;place-items:center;margin:0}.card{background:white;padding:26px;border-radius:18px;width:min(88vw,360px);box-shadow:0 5px 24px #0001}h2{color:#073b35}input,button{font:inherit;width:100%;box-sizing:border-box;padding:13px;border-radius:10px;margin-top:12px}input{border:1px solid #ccd8d3}button{background:#073b35;color:white;border:0;font-weight:bold}.err{color:#a22}</style><main class="card"><h2>Sky Solar Energy</h2><p>بۆ چوونەژوورەوە وشەی نهێنی بنووسە</p>${error?'<p class="err">وشەی نهێنی هەڵەیە. دووبارە هەوڵ بدەرەوە.</p>':''}<form method="post" action="/login"><input type="password" name="password" required autocomplete="current-password" placeholder="وشەی نهێنی"><button type="submit">چوونەژوورەوە</button></form></main></html>`;
}
function requireAuth(req,res,next) { if (!req.session || !req.session.authenticated) return res.status(401).json({error:'Authentication required'}); next(); }
function safeEqual(a,b) { const x=Buffer.from(String(a)); const y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); }
async function telegram(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text,disable_web_page_preview:true}) });
  const data = await r.json().catch(()=>({}));
  if (!r.ok || !data.ok) throw new Error('Telegram send failed');
}
function usd(n) { return '$' + Number(n || 0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function localDate() { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
function writeEvent(ev) { fs.appendFileSync(LOG_FILE, JSON.stringify(ev)+'\n', {encoding:'utf8',mode:0o600}); }
function readEvents() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
}
app.get('/login', (req,res)=>{ if(req.session.authenticated) return res.redirect('/'); res.type('html').send(loginPage()); });
app.post('/login', loginLimiter, (req,res)=>{
  if (!safeEqual(req.body.password || '', process.env.APP_PASSWORD)) return res.status(401).type('html').send(loginPage('error'));
  req.session.regenerate(err=>{ if(err) return res.status(500).send('Could not start secure session'); req.session.authenticated=true; req.session.save(()=>res.redirect('/')); });
});
app.post('/logout', requireAuth, (req,res)=>req.session.destroy(()=>res.redirect('/login')));
app.get('/', (req,res)=>{ if(!req.session.authenticated) return res.redirect('/login'); res.sendFile(path.join(__dirname,'public','index.html')); });
app.get('/health', (_req,res)=>res.json({ok:true}));
app.post('/api/events', requireAuth, apiLimiter, async (req,res)=>{
  const {type,sale,extra={}} = req.body || {};
  if (!['sale','payment'].includes(type) || !sale || typeof sale !== 'object') return res.status(400).json({error:'Invalid event'});
  const total=Number(sale.total), paid=Number(sale.paid), balance=Number(sale.balance), profit=Number(sale.profit), qty=Number(sale.qty);
  if (![total,paid,balance,profit,qty].every(Number.isFinite) || total<0 || paid<0 || balance<0 || qty<0) return res.status(400).json({error:'Invalid numeric values'});
  const ev={type,at:new Date().toISOString(),date:String(sale.date||localDate()).slice(0,10),total,paid,balance,profit,qty,productName:String(sale.productName||'').slice(0,120),customer:String(sale.customer||'').slice(0,120),received:type==='payment'?Number(extra.received||0):0};
  try {
    writeEvent(ev);
    const msg = type==='sale'
      ? `☀️ Sky Solar Energy — فرۆشتنی نوێ\n📅 بەروار: ${ev.date}\n📦 کاڵا: ${ev.productName}\n🔢 ژمارە: ${ev.qty}\n👤 کڕیار: ${ev.customer||'—'}\n💰 کۆی فرۆشتن: ${usd(ev.total)}\n✅ پارەی وەرگیراو: ${usd(ev.paid)}\n🧾 قەرزی ماوە: ${usd(ev.balance)}\n📈 قازانج: ${usd(ev.profit)}`
      : `☀️ Sky Solar Energy — پارەی قەرز وەرگیرا\n📅 بەروار: ${ev.date}\n📦 کاڵا: ${ev.productName}\n👤 کڕیار: ${ev.customer||'—'}\n💵 پارەی تازە وەرگیراو: ${usd(ev.received)}\n🧾 قەرزی ماوە: ${usd(ev.balance)}`;
    await telegram(msg);
    res.json({ok:true,notified:true});
  } catch(err) { console.error('Event processing/Telegram error:',err.message); res.status(502).json({ok:false,notified:false,error:'Notification failed; event was logged if disk write succeeded'}); }
});
async function sendDailyReport() {
  const today=localDate(); const evs=readEvents().filter(e=>e.date===today);
  const sales=evs.filter(e=>e.type==='sale'); const pays=evs.filter(e=>e.type==='payment');
  const total=sales.reduce((a,e)=>a+e.total,0), profit=sales.reduce((a,e)=>a+e.profit,0), received=sales.reduce((a,e)=>a+e.paid,0)+pays.reduce((a,e)=>a+e.received,0), debt=sales.reduce((a,e)=>a+e.balance,0)-pays.reduce((a,e)=>a+e.received,0);
  const msg=`📊 Sky Solar Energy — ڕاپۆرتی ڕۆژانە\n📅 ${today}\n🧾 ژمارەی فرۆشتن: ${sales.length}\n💰 کۆی فرۆشتن: ${usd(total)}\n📈 قازانجی فرۆشتن: ${usd(profit)}\n✅ پارەی وەرگیراو (لە فرۆشتن و قەرز): ${usd(received)}\n📌 قەرزی نوێی خەمڵێنراو: ${usd(Math.max(0,debt))}`;
  await telegram(msg);
}
// 23:55 Iraq time daily report. It summarizes events received by this server only.
cron.schedule('55 23 * * *',()=>sendDailyReport().catch(e=>console.error('Daily report failed:',e.message)),{timezone:'Asia/Baghdad'});
app.listen(PORT,()=>console.log(`Sky Solar backend listening on port ${PORT}`));
