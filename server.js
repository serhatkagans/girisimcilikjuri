// Jüri Değerlendirme Sistemi - bağımlılıksız Node.js sunucusu
// Çalıştırma: baslat.bat (ya da npm start)  ->  http://localhost:3000
// Ayarlar ortam değişkenlerinden / .env dosyasından okunur (bkz. .env.example).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'juri.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// Ortak jüri şifresi kodda tutulmaz: .env içindeki JURI_SIFRE
const SIFRE = process.env.JURI_SIFRE;
if (!SIFRE) {
  console.error('JURI_SIFRE tanımlı değil. .env.example dosyasını .env olarak kopyalayıp şifreyi yazın.');
  process.exit(1);
}
const USERS = { juri1: SIFRE, juri2: SIFRE, juri3: SIFRE };

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Şifre deneme sınırı: bir IP 10 dakikada en fazla 10 hatalı deneme yapabilir
const failures = new Map(); // ip -> { count, until }
const FAIL_LIMIT = 10, FAIL_WINDOW = 10 * 60 * 1000;
function clientIp(req) {
  const fwd = TRUST_PROXY && req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress;
}

const GROUPS = [
  'Muş', 'Aydın', 'Trabzon', 'Batman', 'Kütahya', 'Edirne', 'Gaziantep', 'Manisa',
  'Bartın', 'Kahramanmaraş', 'Denizli', 'Ankara', 'Samsun', 'Bingöl', 'İzmir',
  'Niğde', 'Bursa', 'Hatay', 'Kırklareli', 'Mersin'
];

const CRITERIA = [
  { name: 'Girişimcilik (fikrin inovatif yönü)', max: 10 },
  { name: 'Ekip Kurma Becerisi', max: 15 },
  { name: 'Yenilikçi Fikirler Sunma ve Ürünler Tasarlayabilme', max: 15 },
  { name: 'Risk Yönetimi', max: 15 },
  { name: 'Kanvas İş Modeli oluşturma', max: 15 },
  { name: 'Girişimine Finansman Kaynak Bulma / Yönetme', max: 15 },
  { name: 'Geliştirilen Fikrin (Girişimin) Sunumu', max: 15 }
];

// SQLite veritabanı (Node 24 yerleşik modülü, ek kurulum gerekmez)
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`CREATE TABLE IF NOT EXISTS oylar (
  juri    TEXT NOT NULL,
  grup    TEXT NOT NULL,
  k1 INTEGER NOT NULL, k2 INTEGER NOT NULL, k3 INTEGER NOT NULL, k4 INTEGER NOT NULL,
  k5 INTEGER NOT NULL, k6 INTEGER NOT NULL, k7 INTEGER NOT NULL,
  toplam  INTEGER NOT NULL,
  zaman   INTEGER NOT NULL,
  PRIMARY KEY (juri, grup)
)`);
const upsertVote = db.prepare(`INSERT INTO oylar (juri, grup, k1, k2, k3, k4, k5, k6, k7, toplam, zaman)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (juri, grup) DO UPDATE SET
    k1 = excluded.k1, k2 = excluded.k2, k3 = excluded.k3, k4 = excluded.k4,
    k5 = excluded.k5, k6 = excluded.k6, k7 = excluded.k7,
    toplam = excluded.toplam, zaman = excluded.zaman`);
const selectAll = db.prepare('SELECT * FROM oylar');
const selectExists = db.prepare('SELECT 1 FROM oylar WHERE juri = ? AND grup = ?');
const deleteVote = db.prepare('DELETE FROM oylar WHERE juri = ? AND grup = ?');

// votes[juri][grup] = { scores: [..], total, time }
function loadVotes() {
  const votes = {};
  for (const j of Object.keys(USERS)) votes[j] = {};
  for (const r of selectAll.all()) {
    if (!votes[r.juri]) continue;
    votes[r.juri][r.grup] = { scores: [r.k1, r.k2, r.k3, r.k4, r.k5, r.k6, r.k7], total: r.toplam, time: r.zaman };
  }
  return votes;
}

const sessions = new Map(); // token -> kullanıcı
const clients = new Set();  // SSE bağlantıları
let lastEvent = null;       // son oy (efekt için)

function state() {
  return { groups: GROUPS, criteria: CRITERIA, juries: Object.keys(USERS), votes: loadVotes(), lastEvent };
}

function broadcast() {
  const msg = `data: ${JSON.stringify(state())}\n\n`;
  for (const res of clients) res.write(msg);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  return token ? sessions.get(token) : null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  try {
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const ip = clientIp(req), now = Date.now();
      let f = failures.get(ip);
      if (f && f.until < now) { failures.delete(ip); f = null; }
      if (f && f.count >= FAIL_LIMIT) {
        return json(res, 429, { error: 'Çok fazla hatalı deneme. Birkaç dakika sonra tekrar deneyin.' });
      }
      const { username, password } = await readBody(req);
      const u = String(username || '').trim().toLowerCase();
      if (USERS[u] && safeEqual(USERS[u], password || '')) {
        failures.delete(ip);
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, u);
        return json(res, 200, { token, user: u });
      }
      failures.set(ip, { count: (f ? f.count : 0) + 1, until: now + FAIL_WINDOW });
      return json(res, 401, { error: 'Kullanıcı adı veya şifre hatalı' });
    }

    if (req.method === 'GET' && url.pathname === '/api/durum') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = auth(req);
      return user ? json(res, 200, { user }) : json(res, 401, { error: 'Oturum geçersiz' });
    }

    if (req.method === 'GET' && url.pathname === '/api/my-votes') {
      const user = auth(req);
      if (!user) return json(res, 401, { error: 'Oturum geçersiz' });
      return json(res, 200, { user, groups: GROUPS, criteria: CRITERIA, votes: loadVotes()[user] });
    }

    if (req.method === 'POST' && url.pathname === '/api/vote') {
      const user = auth(req);
      if (!user) return json(res, 401, { error: 'Oturum geçersiz, tekrar giriş yapın' });
      const { group, scores } = await readBody(req);
      if (!GROUPS.includes(group)) return json(res, 400, { error: 'Geçersiz grup' });
      if (!Array.isArray(scores) || scores.length !== CRITERIA.length) {
        return json(res, 400, { error: 'Tüm kriterler puanlanmalıdır' });
      }
      for (let i = 0; i < CRITERIA.length; i++) {
        const s = scores[i];
        if (!Number.isInteger(s) || s < 1 || s > CRITERIA[i].max) {
          return json(res, 400, { error: `"${CRITERIA[i].name}" için 1-${CRITERIA[i].max} arası puan seçin` });
        }
      }
      const total = scores.reduce((a, b) => a + b, 0);
      const updated = !!selectExists.get(user, group);
      upsertVote.run(user, group, ...scores, total, Date.now());
      lastEvent = { id: Date.now(), jury: user, group, scores, total, updated };
      broadcast();
      return json(res, 200, { ok: true, total });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/vote') {
      const user = auth(req);
      if (!user) return json(res, 401, { error: 'Oturum geçersiz, tekrar giriş yapın' });
      const group = url.searchParams.get('group');
      if (!GROUPS.includes(group)) return json(res, 400, { error: 'Geçersiz grup' });
      // Jüri yalnızca kendi verdiği puanı silebilir
      const { changes } = deleteVote.run(user, group);
      if (!changes) return json(res, 404, { error: 'Bu grup için kayıtlı puanınız yok' });
      lastEvent = { id: Date.now(), type: 'deleted', jury: user, group };
      broadcast();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`data: ${JSON.stringify({ ...state(), lastEvent: null })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'GET') {
      const routes = { '/': '/ekran.html', '/juri': '/juri.html' };
      const file = routes[url.pathname] || decodeURIComponent(url.pathname);
      const full = path.normalize(path.join(PUBLIC_DIR, file));
      if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Yasak' });
      return fs.readFile(full, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Bulunamadı'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(buf);
      });
    }

    json(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    json(res, 400, { error: 'Geçersiz istek' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nJüri Değerlendirme Sistemi çalışıyor:`);
  console.log(`  Ana ekran (canlı sıralama): http://localhost:${PORT}/`);
  console.log(`  Jüri paneli               : http://localhost:${PORT}/juri`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) {
        console.log(`  Ağdaki cihazlar           : http://${n.address}:${PORT}/  ve  /juri`);
      }
    }
  }
  console.log('');
});
