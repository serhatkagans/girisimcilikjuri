// Jüri Değerlendirme Sistemi - bağımlılıksız Node.js sunucusu
// Çalıştırma: baslat.bat (ya da npm start)  ->  http://localhost:3000
// Ayarlar ortam değişkenlerinden / .env dosyasından okunur (bkz. .env.example).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'juri.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// Ana ekranın alt bandı: etkinlik bilgisi .env'den, destekçi logoları public/logolar/ klasöründen
const EVENT = { tarih: process.env.ETKINLIK_TARIH || '', yer: process.env.ETKINLIK_YER || '' };
const LOGO_DIR = path.join(PUBLIC_DIR, 'logolar');
function sponsorLogos() {
  try {
    return fs.readdirSync(LOGO_DIR).filter(f => /\.(png|jpe?g|svg|webp)$/i.test(f)).sort();
  } catch { return []; }
}

// Ortak jüri şifresi kodda tutulmaz: .env içindeki JURI_SIFRE
const SIFRE = process.env.JURI_SIFRE;
if (!SIFRE) {
  console.error('JURI_SIFRE tanımlı değil. .env.example dosyasını .env olarak kopyalayıp şifreyi yazın.');
  process.exit(1);
}

// Jüri üyeleri: kullanıcı adı = isim + soyisim, bitişik, küçük harf, Türkçe karaktersiz
const JURIES = [
  { id: 'alidemir', name: 'Prof. Dr. Ali DEMİR' },
  { id: 'yasinozarslan', name: 'Prof. Dr. Yasin ÖZARSLAN' },
  { id: 'eliftunalicaliskan', name: 'Prof. Dr. Elif TUNALI ÇALIŞKAN' },
  { id: 'yeldatufekci', name: 'Yelda TÜFEKÇİ' },
  { id: 'samikaraoglan', name: 'Sami KARAOĞLAN' }
];
const USERS = Object.fromEntries(JURIES.map(j => [j.id, SIFRE]));
const JURY_NAME = Object.fromEntries(JURIES.map(j => [j.id, j.name]));

// Kullanıcı adı Türkçe karakterle ya da boşluklu yazılsa da kabul edilir:
// "Ali Demir", "alidemir", "ALİDEMİR" -> "alidemir"
function normalizeUser(u) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
  return String(u || '').toLocaleLowerCase('tr').replace(/[çğıöşüâîû]/g, c => map[c]).replace(/[^a-z0-9]/g, '');
}

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

// Jürinin oylama sırası
const GROUPS = [
  'Trabzon', 'Mersin', 'Edirne', 'Bartın', 'Gaziantep', 'Bursa', 'İzmir', 'Kırklareli',
  'Kahramanmaraş', 'Kütahya', 'Manisa', 'Samsun', 'Batman', 'Ankara', 'Hatay',
  'Niğde', 'Aydın', 'Muş', 'Denizli', 'Bingöl'
];

// İllerin takım isimleri (sunum sırası yukarıdaki GROUPS listesidir)
const TEAMS = {
  Ankara: 'Mergen', Aydın: 'Guards Of Life', Bartın: 'PAFLAGONIA', Batman: 'NovaX⁴',
  Bingöl: 'KAMADUA-FORCE', Bursa: 'Atlas', Denizli: 'Arcthus Tech', Edirne: 'BİLSEMERA TECH',
  Gaziantep: 'ROTOREX', Hatay: 'Ecovate', İzmir: 'İzmir Ekibi', Kahramanmaraş: 'Nexus',
  Kırklareli: 'Genç Girişimciler', Kütahya: 'Grup Qtahya', Manisa: 'Manisa Ekibi', Mersin: 'PUSULA',
  Muş: 'Qucadio', Niğde: 'Tyana Nova', Samsun: 'NovaSamsun', Trabzon: 'EvoPassTr'
};

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

// ---- XLSX dışa aktarma (bağımlılıksız: elle yazılmış OOXML + ZIP) ----
function zip(files) { // files: [[ad, içerik]]
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, comp);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const xmlEsc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function colName(i) { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; }

// Hücre: metin / sayı / null ya da { v, s } (s: 1 kalın başlık, 3 kalın + bir ondalık)
function sheetXml(rows, widths) {
  const body = rows.map((row, r) => `<row r="${r + 1}">` + row.map((c, i) => {
    const cell = c !== null && typeof c === 'object' ? c : { v: c };
    if (cell.v === null || cell.v === undefined || cell.v === '') return '';
    const ref = colName(i) + (r + 1), st = cell.s ? ` s="${cell.s}"` : '';
    return typeof cell.v === 'number'
      ? `<c r="${ref}"${st}><v>${cell.v}</v></c>`
      : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(cell.v)}</t></is></c>`;
  }).join('') + '</row>').join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${body}</sheetData></worksheet>`;
}

function workbook(sheets) { // sheets: [{ name, rows, widths }]
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  return zip([
    ['[Content_Types].xml', ct], ['_rels/.rels', rels], ['xl/workbook.xml', wb],
    ['xl/_rels/workbook.xml.rels', wbRels], ['xl/styles.xml', styles],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths)])
  ]);
}

// Sıralama ana ekrandakiyle aynı: ortalama, sonra oy veren jüri sayısı, sonra sunum sırası
function scoresXlsx() {
  const votes = loadVotes();
  const H = v => ({ v, s: 1 });
  const round1 = x => Math.round(x * 10) / 10;
  const stats = GROUPS.map((g, order) => {
    const per = JURIES.map(j => votes[j.id][g] || null);
    const done = per.filter(Boolean);
    const avg = done.length ? done.reduce((a, v) => a + v.total, 0) / done.length : null;
    return { g, order, per, done, avg };
  });
  const ranked = [...stats].sort((a, b) => (b.avg || 0) - (a.avg || 0) || b.done.length - a.done.length || a.order - b.order);

  const ranking = [[H('Sıra'), H('İl'), H('Takım'), H('Ortalama'), H('Oy veren jüri'), ...JURIES.map(j => H(j.name))]];
  ranked.forEach((s, i) => ranking.push([
    s.done.length ? i + 1 : null, s.g, TEAMS[s.g] || '',
    s.avg === null ? null : { v: round1(s.avg), s: 3 }, `${s.done.length} / ${JURIES.length}`,
    ...s.per.map(v => v ? v.total : null)
  ]));

  const detail = [[H('Sunum sırası'), H('İl'), H('Takım'), H('Jüri'), ...CRITERIA.map(c => H(`${c.name} (/${c.max})`)), H('Toplam (/100)'), H('Oy zamanı')]];
  const when = t => new Date(t).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  for (const s of stats) {
    JURIES.forEach((j, k) => {
      const v = s.per[k];
      detail.push([s.order + 1, s.g, TEAMS[s.g] || '', j.name, ...(v ? v.scores : CRITERIA.map(() => null)), v ? v.total : null, v ? when(v.time) : 'Puanlamadı']);
    });
    if (s.done.length) {
      detail.push([null, s.g, TEAMS[s.g] || '', H('Ortalama'),
        ...CRITERIA.map((_, i) => ({ v: round1(s.done.reduce((a, v) => a + v.scores[i], 0) / s.done.length), s: 3 })),
        { v: round1(s.avg), s: 3 }, null]);
    }
  }

  return workbook([
    { name: 'Sıralama', rows: ranking, widths: [7, 16, 20, 11, 13, ...JURIES.map(() => 18)] },
    { name: 'Jüri Ayrıntısı', rows: detail, widths: [9, 16, 20, 32, ...CRITERIA.map(() => 16), 12, 20] }
  ]);
}

const sessions = new Map(); // token -> kullanıcı
const clients = new Set();  // SSE bağlantıları
let lastEvent = null;       // son oy (efekt için)

function state() {
  return { groups: GROUPS, teams: TEAMS, criteria: CRITERIA, juries: JURIES, votes: loadVotes(), lastEvent, event: EVENT, sponsors: sponsorLogos() };
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

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
      const u = normalizeUser(username);
      if (USERS[u] && safeEqual(USERS[u], password || '')) {
        failures.delete(ip);
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, u);
        return json(res, 200, { token, user: u, name: JURY_NAME[u] });
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
      return json(res, 200, { user, name: JURY_NAME[user], groups: GROUPS, teams: TEAMS, criteria: CRITERIA, votes: loadVotes()[user] });
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
      lastEvent = { id: Date.now(), jury: user, juryName: JURY_NAME[user], group, scores, total, updated };
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
      lastEvent = { id: Date.now(), type: 'deleted', jury: user, juryName: JURY_NAME[user], group };
      broadcast();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/puanlar.xlsx') {
      const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }).slice(0, 16).replace(' ', '_').replace(':', '');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="demoday-puanlar-${stamp}.xlsx"`,
        'Cache-Control': 'no-store'
      });
      return res.end(scoresXlsx());
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
  // Ağ adresleri yalnızca yerel ağda yayın yapılırken gösterilir
  // (sunucuda 127.0.0.1 dinlenir ve systemd ağ arayüzlerinin okunmasına izin vermez)
  if (HOST === '0.0.0.0') {
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const n of list || []) {
          if (n.family === 'IPv4' && !n.internal) {
            console.log(`  Ağdaki cihazlar           : http://${n.address}:${PORT}/  ve  /juri`);
          }
        }
      }
    } catch (_) { /* ağ arayüzleri okunamadı */ }
  }
  console.log('');
});
