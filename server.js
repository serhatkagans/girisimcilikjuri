// Jüri Değerlendirme Sistemi - bağımlılıksız Node.js sunucusu
// Çalıştırma: baslat.bat (ya da npm start)  ->  http://localhost:3000
// Sunucu ayarları ortam değişkenlerinden / .env dosyasından okunur (bkz. .env.example).
// Etkinlik ayarları (iller, jüriler, kriterler, logolar, şifreler) veritabanındadır
// ve yönetim panelinden (/yonetim) değiştirilir.
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

// Destekçi logoları: panelden yüklenenler DATA_DIR/logolar/ (sunucuda tek yazılabilir yer data/),
// elle konanlar public/logolar/ klasöründe
const LOGO_DIR = path.join(DATA_DIR, 'logolar');
const PUBLIC_LOGO_DIR = path.join(PUBLIC_DIR, 'logolar');
const LOGO_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.(png|jpe?g|svg|webp)$/i;
const listDir = dir => { try { return fs.readdirSync(dir).filter(f => LOGO_RE.test(f)); } catch { return []; } };
function sponsorLogos() {
  const order = CFG.logolar || [];
  const rank = f => { const i = order.indexOf(f); return i < 0 ? Infinity : i; };
  return [...new Set([...listDir(LOGO_DIR), ...listDir(PUBLIC_LOGO_DIR)])]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// Kullanıcı adı Türkçe karakterle ya da boşluklu yazılsa da kabul edilir:
// "Ali Demir", "alidemir", "ALİDEMİR" -> "alidemir"
function normalizeUser(u) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
  return String(u || '').toLocaleLowerCase('tr').replace(/[çğıöşüâîû]/g, c => map[c]).replace(/[^a-z0-9]/g, '');
}
const stripTitles = n => String(n || '').replace(/^(Prof\.|Doç\.|Dr\.|Öğr\. ?Gör\.|Arş\. ?Gör\.|\s)+/g, '');

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

// ---- Varsayılan ayarlar: yalnızca İLK çalıştırmada veritabanına yazılır ----
// Sonrasında her şey yönetim panelinden değişir; buradaki listeyi düzenlemek kurulu sistemi etkilemez.
const DEFAULT_GROUPS = [ // sunum sırası
  ['Trabzon', 'EvoPassTr'], ['Mersin', 'PUSULA'], ['Edirne', 'BİLSEMERA TECH'], ['Bartın', 'PAFLAGONIA'],
  ['Gaziantep', 'ROTOREX'], ['Bursa', 'Atlas'], ['İzmir', 'İzmir Ekibi'], ['Kırklareli', 'Genç Girişimciler'],
  ['Kahramanmaraş', 'Nexus'], ['Kütahya', 'Grup Qtahya'], ['Manisa', 'Manisa Ekibi'], ['Samsun', 'NovaSamsun'],
  ['Batman', 'NovaX⁴'], ['Ankara', 'Mergen'], ['Hatay', 'Ecovate'], ['Niğde', 'Tyana Nova'],
  ['Aydın', 'Guards Of Life'], ['Muş', 'Qucadio'], ['Denizli', 'Arcthus Tech'], ['Bingöl', 'KAMADUA-FORCE']
];
const DEFAULTS = {
  event: {
    kurum: 'ETKİM', ad: 'Genç Tekno Girişimcilik Kampı', etkinlik: 'Demo Day',
    tarih: process.env.ETKINLIK_TARIH || '', yer: process.env.ETKINLIK_YER || ''
  },
  // Jüri kullanıcı adı = isim + soyisim, bitişik, küçük harf, Türkçe karaktersiz
  juries: [
    { id: 'alidemir', name: 'Prof. Dr. Ali DEMİR' },
    { id: 'yasinozarslan', name: 'Prof. Dr. Yasin ÖZARSLAN' },
    { id: 'eliftunalicaliskan', name: 'Prof. Dr. Elif TUNALI ÇALIŞKAN' },
    { id: 'yeldatufekci', name: 'Yelda TÜFEKÇİ' },
    { id: 'sumeyyeyilmaz', name: 'Sümeyye YILMAZ' }
  ],
  groups: DEFAULT_GROUPS.map(([il, takim]) => ({ il, takim })),
  criteria: [ // short: ana ekrandaki ayrıntı tablosunun sütun başlığı
    { name: 'Girişimcilik (fikrin inovatif yönü)', short: 'Girişimcilik', max: 15 },
    { name: 'Ekip Kurma Becerisi', short: 'Ekip Kurma', max: 10 },
    { name: 'Yenilikçi Fikirler Sunma ve Ürünler Tasarlayabilme', short: 'Yenilikçilik', max: 15 },
    { name: 'Problem ile Çözüm Uyumu', short: 'Problem–Çözüm', max: 15 },
    { name: 'İş Modeli Sürdürülebilir mi?', short: 'Sürdürülebilirlik', max: 15 },
    { name: 'Girişimine Finansman Kaynak Bulma / Yönetme', short: 'Finansman', max: 15 },
    { name: 'Geliştirilen Fikrin (Girişimin) Sunumu', short: 'Sunum', max: 15 }
  ],
  oylamaAcik: true, // kapalıyken jüriler oy veremez / silemez
  sahne: null,      // null: sahnedeki il otomatik (oylaması bitmeyen ilk il); dolu: panelden seçilen il
  logolar: [],      // logo gösterim sırası (dosya adları)
  surum: 1          // yapı her değiştiğinde artar; açık ekranlar kendini yeniler
};

// SQLite veritabanı (Node 24 yerleşik modülü, ek kurulum gerekmez)
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
let txDepth = 0; // iç içe çağrılarda yalnızca en dıştaki işlem açılır
function tx(fn) {
  if (txDepth) return fn();
  db.exec('BEGIN'); txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { txDepth--; }
}

db.exec('CREATE TABLE IF NOT EXISTS ayarlar (anahtar TEXT PRIMARY KEY, deger TEXT NOT NULL)');
const getSetting = db.prepare('SELECT deger FROM ayarlar WHERE anahtar = ?');
const putSetting = db.prepare(`INSERT INTO ayarlar (anahtar, deger) VALUES (?, ?)
  ON CONFLICT (anahtar) DO UPDATE SET deger = excluded.deger`);
const readSetting = (k, def) => { const r = getSetting.get(k); return r ? JSON.parse(r.deger) : def; };
const writeSetting = (k, v) => putSetting.run(k, JSON.stringify(v));

let CFG = readSetting('ayarlar', null);
if (!CFG) { CFG = structuredClone(DEFAULTS); writeSetting('ayarlar', CFG); }
CFG = { ...structuredClone(DEFAULTS), ...CFG };

// Şifreler ayrı tutulur ve hiçbir zaman istemciye gitmez. Yalnızca scrypt özetleri saklanır.
// ortak: tüm jürilerin şifresi (panelden belirlenmediyse .env'deki JURI_SIFRE)
// juri[id]: o jüriye özel şifre (varsa ortak şifrenin yerine geçer)
// admin: yönetim paneli şifresi (panelden belirlenmediyse .env'deki ADMIN_SIFRE)
let SECRETS = { ortak: null, admin: null, juri: {}, ...readSetting('sifreler', {}) };
const saveSecrets = () => writeSetting('sifreler', SECRETS);

function hashPw(p) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex');
}
function checkPw(p, stored) {
  const [salt, hash] = String(stored).split(':');
  const x = crypto.scryptSync(String(p), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(x, Buffer.from(hash, 'hex'));
}
function juryPasswordOk(u, p) {
  const h = SECRETS.juri[u] || SECRETS.ortak;
  if (h) return checkPw(p, h);
  return !!process.env.JURI_SIFRE && safeEqual(process.env.JURI_SIFRE, p);
}
const adminConfigured = () => !!(SECRETS.admin || process.env.ADMIN_SIFRE);
function adminPasswordOk(p) {
  if (SECRETS.admin) return checkPw(p, SECRETS.admin);
  return !!process.env.ADMIN_SIFRE && safeEqual(process.env.ADMIN_SIFRE, p);
}

// Ayarlardan türeyen, kodun her yerinde kullanılan listeler
let GROUPS, TEAMS, JURIES, JURY_NAME, CRITERIA, MAX_TOTAL;
function applyCfg() {
  GROUPS = CFG.groups.map(g => g.il);
  TEAMS = Object.fromEntries(CFG.groups.filter(g => g.takim).map(g => [g.il, g.takim]));
  JURIES = CFG.juries.map(j => ({ id: j.id, name: j.name }));
  JURY_NAME = Object.fromEntries(JURIES.map(j => [j.id, j.name]));
  CRITERIA = CFG.criteria.map(c => ({ name: c.name, short: c.short || '', max: c.max }));
  MAX_TOTAL = CRITERIA.reduce((a, c) => a + c.max, 0);
}
// bump: açık ekranların kendini yenilemesi gereken (yapısal) değişiklik
function saveCfg(bump) {
  if (bump) CFG.surum = (CFG.surum || 0) + 1;
  writeSetting('ayarlar', CFG);
  applyCfg();
}
applyCfg();

// Oylar: puanlar kriter sayısı kadar elemanlı bir JSON dizisi
function createVotesTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS oylar (
    juri    TEXT NOT NULL,
    grup    TEXT NOT NULL,
    puanlar TEXT NOT NULL,
    toplam  INTEGER NOT NULL,
    zaman   INTEGER NOT NULL,
    PRIMARY KEY (juri, grup)
  )`);
}
// Eski şema (k1..k7 sabit sütunlar) bir kereliğine yeni şemaya taşınır
if (db.prepare('PRAGMA table_info(oylar)').all().some(c => c.name === 'k1')) {
  tx(() => {
    db.exec('ALTER TABLE oylar RENAME TO oylar_eski');
    createVotesTable();
    const ins = db.prepare('INSERT INTO oylar (juri, grup, puanlar, toplam, zaman) VALUES (?, ?, ?, ?, ?)');
    for (const r of db.prepare('SELECT * FROM oylar_eski').all()) {
      ins.run(r.juri, r.grup, JSON.stringify([r.k1, r.k2, r.k3, r.k4, r.k5, r.k6, r.k7]), r.toplam, r.zaman);
    }
    db.exec('DROP TABLE oylar_eski');
  });
  console.log('Oylar tablosu yeni şemaya taşındı.');
} else createVotesTable();

const upsertVote = db.prepare(`INSERT INTO oylar (juri, grup, puanlar, toplam, zaman) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (juri, grup) DO UPDATE SET puanlar = excluded.puanlar, toplam = excluded.toplam, zaman = excluded.zaman`);
const selectAll = db.prepare('SELECT * FROM oylar');
const selectExists = db.prepare('SELECT 1 FROM oylar WHERE juri = ? AND grup = ?');
const deleteVote = db.prepare('DELETE FROM oylar WHERE juri = ? AND grup = ?');

// votes[juri][grup] = { scores: [..], total, time }
function loadVotes() {
  const votes = {};
  for (const j of JURIES) votes[j.id] = {};
  for (const r of selectAll.all()) {
    if (!votes[r.juri] || !GROUPS.includes(r.grup)) continue;
    votes[r.juri][r.grup] = { scores: JSON.parse(r.puanlar), total: r.toplam, time: r.zaman };
  }
  return votes;
}

// Puan dizisi kriterlere uygun mu? Uygun değilse hata mesajı döner
function scoreError(scores) {
  if (!Array.isArray(scores) || scores.length !== CRITERIA.length) return 'Tüm kriterler puanlanmalıdır';
  for (let i = 0; i < CRITERIA.length; i++) {
    const s = scores[i];
    if (!Number.isInteger(s) || s < 1 || s > CRITERIA[i].max) {
      return `"${CRITERIA[i].name}" için 1-${CRITERIA[i].max} arası puan seçin`;
    }
  }
  return null;
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

  const detail = [[H('Sunum sırası'), H('İl'), H('Takım'), H('Jüri'), ...CRITERIA.map(c => H(`${c.name} (/${c.max})`)), H(`Toplam (/${MAX_TOTAL})`), H('Oy zamanı')]];
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


// Oturumlar veritabanında: sunucu yeniden başlasa da jüri girişte kalır.
// Jeton açık tutulmaz, yalnızca SHA-256 özeti saklanır. Yönetici oturumları juri = '@admin'.
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 saat
const ADMIN = '@admin', ADMIN_TTL = 12 * 60 * 60 * 1000;
db.exec(`CREATE TABLE IF NOT EXISTS oturumlar (
  ozet  TEXT PRIMARY KEY,
  juri  TEXT NOT NULL,
  bitis INTEGER NOT NULL
)`);
const insertSession = db.prepare('INSERT INTO oturumlar (ozet, juri, bitis) VALUES (?, ?, ?)');
const selectSession = db.prepare('SELECT juri, bitis FROM oturumlar WHERE ozet = ?');
const deleteSession = db.prepare('DELETE FROM oturumlar WHERE ozet = ?');
const deleteJurySessions = db.prepare('DELETE FROM oturumlar WHERE juri = ?');
const purgeSessions = db.prepare('DELETE FROM oturumlar WHERE bitis < ?');
const sessionCounts = db.prepare('SELECT juri, COUNT(*) AS n FROM oturumlar WHERE bitis >= ? GROUP BY juri');
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
purgeSessions.run(Date.now());

const clients = new Set();  // SSE bağlantıları
let lastEvent = null;       // son oy (efekt için)

function state() {
  return {
    groups: GROUPS, teams: TEAMS, criteria: CRITERIA, juries: JURIES, maxTotal: MAX_TOTAL,
    votes: loadVotes(), lastEvent, event: CFG.event, sponsors: sponsorLogos(),
    sahne: GROUPS.includes(CFG.sahne) ? CFG.sahne : null, oylamaAcik: CFG.oylamaAcik, surum: CFG.surum
  };
}

function broadcast() {
  const msg = `data: ${JSON.stringify(state())}\n\n`;
  for (const res of clients) res.write(msg);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Kullanıcıya gösterilecek hata: catch bloğunda kodu ve mesajıyla yanıtlanır
function fail(code, msg, extra) { throw Object.assign(new Error(msg), { http: code, extra }); }

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Dosya çok büyük'), { http: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readBody(req, limit = 1e5) {
  const buf = await readRaw(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { fail(400, 'Geçersiz istek'); }
}

function sessionOf(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const s = selectSession.get(tokenHash(token));
  return s && s.bitis >= Date.now() ? s.juri : null;
}
// Süresi dolmuş ya da listeden çıkarılmış jürinin oturumu geçersiz
function auth(req) { const u = sessionOf(req); return u && JURY_NAME[u] ? u : null; }
const adminAuth = req => sessionOf(req) === ADMIN;

function loginLimited(req) {
  const ip = clientIp(req), now = Date.now();
  let f = failures.get(ip);
  if (f && f.until < now) { failures.delete(ip); f = null; }
  if (f && f.count >= FAIL_LIMIT) fail(429, 'Çok fazla hatalı deneme. Birkaç dakika sonra tekrar deneyin.');
  return {
    ok() { failures.delete(ip); },
    bad() { failures.set(ip, { count: (f ? f.count : 0) + 1, until: now + FAIL_WINDOW }); }
  };
}
function newSession(who, ttl) {
  const token = crypto.randomBytes(24).toString('hex'), now = Date.now();
  purgeSessions.run(now);
  insertSession.run(tokenHash(token), who, now + ttl);
  return token;
}

// ---- Yönetim paneli işlemleri ----
// Ekranlara HTML olarak basılan metinlerde etiket karakterlerine izin verilmez
const str = (v, max = 120) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, max);
const trKey = s => s.toLocaleLowerCase('tr');

// Oylar tablosunda bir sütundaki anahtarları toplu yeniden adlandırır (takas güvenli: önce geçici ada).
// col yalnızca kod içinden 'juri' ya da 'grup' gelir.
function renameKeys(col, pairs) {
  const upd = db.prepare(`UPDATE oylar SET ${col} = ? WHERE ${col} = ?`);
  pairs.forEach(([from], i) => upd.run(`\u0001${i}`, from));
  pairs.forEach(([, to], i) => upd.run(to, `\u0001${i}`));
}
// Listeden çıkarılan il / jürinin oyları silinir
function dropKeys(col, keys) {
  const del = db.prepare(`DELETE FROM oylar WHERE ${col} = ?`);
  for (const k of keys) del.run(k);
}

// Liste: [{ eski, il, takim }] — eski: mevcut il adı (yeniden adlandırma için), yeni satırda boş.
// Listede olmayan illerin oyları silinir.
function setGroups(list) {
  if (!Array.isArray(list) || !list.length) fail(400, 'En az bir il olmalı');
  const seen = new Set();
  const rows = list.map(x => {
    const il = str(x.il, 60), takim = str(x.takim, 80);
    const eski = GROUPS.includes(x.eski) ? x.eski : null;
    if (!il) fail(400, 'İl adı boş bırakılamaz');
    if (seen.has(trKey(il))) fail(400, `"${il}" listede iki kez var`);
    seen.add(trKey(il));
    return { il, takim, eski };
  });
  tx(() => {
    const moved = rows.filter(r => r.eski && r.eski !== r.il);
    dropKeys('grup', GROUPS.filter(g => !rows.some(r => r.eski === g)));
    renameKeys('grup', moved.map(r => [r.eski, r.il]));
  });
  const ren = rows.find(r => r.eski === CFG.sahne);
  CFG.sahne = ren ? ren.il : null;
  CFG.groups = rows.map(({ il, takim }) => ({ il, takim }));
  saveCfg(true);
}

// Liste: [{ eski, id, name }] — id boşsa isimden üretilir (unvanlar atılır)
function setJuries(list) {
  if (!Array.isArray(list) || !list.length) fail(400, 'En az bir jüri olmalı');
  const seen = new Set();
  const rows = list.map(x => {
    const name = str(x.name, 80);
    if (!name) fail(400, 'Jüri adı boş bırakılamaz');
    const id = normalizeUser(x.id) || normalizeUser(stripTitles(name));
    if (!id) fail(400, `"${name}" için kullanıcı adı üretilemedi`);
    if (seen.has(id)) fail(400, `"${id}" kullanıcı adı iki kez var`);
    seen.add(id);
    return { id, name, eski: JURY_NAME[x.eski] ? x.eski : null };
  });
  tx(() => {
    const moved = rows.filter(r => r.eski && r.eski !== r.id);
    dropKeys('juri', JURIES.map(j => j.id).filter(id => !rows.some(r => r.eski === id)));
    renameKeys('juri', moved.map(r => [r.eski, r.id]));
    // Kullanıcı adı değişen ya da çıkarılan jürinin oturumu kapanır, özel şifresi taşınır
    const keep = new Set(rows.filter(r => r.eski === r.id).map(r => r.id));
    for (const j of JURIES) if (!keep.has(j.id)) deleteJurySessions.run(j.id);
    const pw = {};
    for (const r of rows) { const h = SECRETS.juri[r.eski || r.id]; if (h && (r.eski || !JURY_NAME[r.id])) pw[r.id] = h; }
    SECRETS.juri = pw;
    saveSecrets();
  });
  CFG.juries = rows.map(({ id, name }) => ({ id, name }));
  saveCfg(true);
}

// Oy varken kriter sayısı değişemez, bir kriterin azami puanı verilmiş puanların altına inemez
function setCriteria(list) {
  if (!Array.isArray(list) || !list.length) fail(400, 'En az bir kriter olmalı');
  const rows = list.map(x => {
    const name = str(x.name, 120), short = str(x.short, 24), max = Number(x.max);
    if (!name) fail(400, 'Kriter adı boş bırakılamaz');
    if (!Number.isInteger(max) || max < 1 || max > 1000) fail(400, `"${name}" için azami puan 1-1000 arası bir tam sayı olmalı`);
    return { name, short, max };
  });
  const all = Object.values(loadVotes()).flatMap(Object.values);
  if (all.length) {
    if (rows.length !== CRITERIA.length) fail(409, `Kayıtlı ${all.length} oy var. Kriter eklemek ya da çıkarmak için önce oyları sıfırlayın.`);
    rows.forEach((c, i) => {
      const top = Math.max(...all.map(v => v.scores[i]));
      // Yalnızca düşürülen sınır denetlenir (eski oylarda sınır zaten aşılmış olabilir)
      if (c.max < CRITERIA[i].max && c.max < top) fail(409, `"${c.name}" için ${top} puan verilmiş; azami puan ${top} altına inemez.`);
    });
  }
  CFG.criteria = rows;
  saveCfg(true);
}

function setEvent(e) {
  CFG.event = {
    kurum: str(e.kurum, 40), ad: str(e.ad, 100), etkinlik: str(e.etkinlik, 60),
    tarih: str(e.tarih, 60), yer: str(e.yer, 100)
  };
  saveCfg(true);
}

function setPassword({ tur, juri, sifre }) {
  const p = String(sifre ?? '');
  if (tur === 'juri') {
    if (!JURY_NAME[juri]) fail(400, 'Jüri bulunamadı');
    if (!p) delete SECRETS.juri[juri]; // özel şifre kaldırılır, ortak şifre geçerli olur
    else if (p.length < 4) fail(400, 'Şifre en az 4 karakter olmalı');
    else SECRETS.juri[juri] = hashPw(p);
    deleteJurySessions.run(juri);
  } else if (tur === 'ortak' || tur === 'admin') {
    if (p.length < (tur === 'admin' ? 6 : 4)) fail(400, `Şifre en az ${tur === 'admin' ? 6 : 4} karakter olmalı`);
    SECRETS[tur] = hashPw(p);
  } else fail(400, 'Geçersiz şifre türü');
  saveSecrets();
}

function adminState() {
  const now = Date.now();
  const sessions = Object.fromEntries(sessionCounts.all(now).map(r => [r.juri, r.n]));
  const own = new Set(listDir(LOGO_DIR));
  return {
    ...state(), lastEvent: null,
    juries: CFG.juries.map(j => ({ ...j, ozelSifre: !!SECRETS.juri[j.id], oturum: sessions[j.id] || 0 })),
    logos: sponsorLogos().map(f => ({ ad: f, silinebilir: own.has(f) })),
    sifre: { ortak: SECRETS.ortak ? 'panel' : process.env.JURI_SIFRE ? 'env' : null, admin: SECRETS.admin ? 'panel' : 'env' },
    oySayisi: Object.values(loadVotes()).reduce((a, v) => a + Object.keys(v).length, 0), istemci: clients.size
  };
}

// Yedek: ayarlar + oylar (şifreler yedeğe girmez)
function backup() {
  return {
    tur: 'juri-yedek', zaman: new Date().toISOString(),
    ayarlar: { event: CFG.event, juries: CFG.juries, groups: CFG.groups, criteria: CFG.criteria, logolar: CFG.logolar, oylamaAcik: CFG.oylamaAcik },
    oylar: selectAll.all().map(r => ({ juri: r.juri, grup: r.grup, puanlar: JSON.parse(r.puanlar), zaman: r.zaman }))
  };
}
function restore(b) {
  if (!b || b.tur !== 'juri-yedek' || !b.ayarlar) fail(400, 'Bu dosya bir yedek dosyası değil');
  const a = b.ayarlar, oldCfg = structuredClone(CFG), oldSecrets = structuredClone(SECRETS);
  try {
    return tx(() => {
      db.exec('DELETE FROM oylar');
      CFG.groups = []; CFG.juries = []; applyCfg(); // yeniden adlandırma eşleşmesi olmasın
      setEvent(a.event || {});
      setGroups(a.groups);
      setJuries(a.juries);
      setCriteria(a.criteria);
      CFG.logolar = Array.isArray(a.logolar) ? a.logolar.filter(f => LOGO_RE.test(f)) : [];
      CFG.oylamaAcik = a.oylamaAcik !== false;
      let skipped = 0;
      for (const v of Array.isArray(b.oylar) ? b.oylar : []) {
        if (!JURY_NAME[v.juri] || !GROUPS.includes(v.grup) || scoreError(v.puanlar)) { skipped++; continue; }
        upsertVote.run(v.juri, v.grup, JSON.stringify(v.puanlar), v.puanlar.reduce((x, y) => x + y, 0), Number(v.zaman) || Date.now());
      }
      saveCfg(true);
      return skipped;
    });
  } catch (e) { CFG = oldCfg; SECRETS = oldSecrets; applyCfg(); throw e; }
}

async function adminRoutes(req, res, url) {
  const p = url.pathname.slice('/api/admin/'.length), m = req.method;

  if (m === 'POST' && p === 'login') {
    if (!adminConfigured()) fail(503, 'Yönetim şifresi tanımlı değil: .env dosyasına ADMIN_SIFRE yazıp sunucuyu yeniden başlatın.');
    const lim = loginLimited(req);
    const { password } = await readBody(req);
    if (!adminPasswordOk(password || '')) { lim.bad(); fail(401, 'Şifre hatalı'); }
    lim.ok();
    return json(res, 200, { token: newSession(ADMIN, ADMIN_TTL) });
  }
  if (!adminAuth(req)) fail(401, 'Yönetici oturumu geçersiz, tekrar giriş yapın');

  if (m === 'POST' && p === 'logout') {
    deleteSession.run(tokenHash((req.headers.authorization || '').slice(7)));
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && p === 'state') return json(res, 200, adminState());

  if (m === 'PUT' && p === 'etkinlik') setEvent(await readBody(req));
  else if (m === 'PUT' && p === 'gruplar') setGroups((await readBody(req)).list);
  else if (m === 'PUT' && p === 'juriler') setJuries((await readBody(req)).list);
  else if (m === 'PUT' && p === 'kriterler') setCriteria((await readBody(req)).list);
  else if (m === 'PUT' && p === 'sifre') { setPassword(await readBody(req)); return json(res, 200, adminState()); }
  else if (m === 'PUT' && p === 'oylama') { CFG.oylamaAcik = !!(await readBody(req)).acik; saveCfg(false); }
  else if (m === 'PUT' && p === 'sahne') {
    const { il } = await readBody(req);
    if (il && !GROUPS.includes(il)) fail(400, 'Geçersiz il');
    CFG.sahne = il || null; saveCfg(false);
  } else if (m === 'PUT' && p === 'oy') {
    const { juri, grup, scores } = await readBody(req);
    if (!JURY_NAME[juri] || !GROUPS.includes(grup)) fail(400, 'Geçersiz jüri ya da il');
    const err = scoreError(scores); if (err) fail(400, err);
    upsertVote.run(juri, grup, JSON.stringify(scores), scores.reduce((a, b) => a + b, 0), Date.now());
    lastEvent = null;
  } else if (m === 'DELETE' && p === 'oy') {
    deleteVote.run(url.searchParams.get('juri'), url.searchParams.get('grup'));
    lastEvent = null;
  } else if (m === 'POST' && p === 'sifirla') {
    if ((await readBody(req)).onay !== 'SIFIRLA') fail(400, 'Onay metni hatalı');
    db.exec('DELETE FROM oylar');
    lastEvent = null; CFG.sahne = null; saveCfg(true);
  } else if (m === 'DELETE' && p === 'oturum') {
    const juri = url.searchParams.get('juri');
    if (juri) deleteJurySessions.run(juri);
    else db.exec(`DELETE FROM oturumlar WHERE juri <> '${ADMIN}'`);
    return json(res, 200, adminState());
  } else if (m === 'POST' && p === 'logo') {
    const ext = (url.searchParams.get('ad') || '').match(/\.(png|jpe?g|svg|webp)$/i);
    if (!ext) fail(400, 'Yalnızca PNG, JPG, SVG ya da WEBP yüklenebilir');
    const base = normalizeUser(path.basename(url.searchParams.get('ad'), ext[0])).slice(0, 60) || 'logo';
    let name = `${base}${ext[0].toLowerCase()}`;
    for (let i = 2; listDir(LOGO_DIR).includes(name) || listDir(PUBLIC_LOGO_DIR).includes(name); i++) name = `${base}-${i}${ext[0].toLowerCase()}`;
    const buf = await readRaw(req, 3 * 1024 * 1024);
    if (!buf.length) fail(400, 'Dosya boş');
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOGO_DIR, name), buf);
    CFG.logolar = [...sponsorLogos().filter(f => f !== name), name];
    saveCfg(true);
  } else if (m === 'DELETE' && p === 'logo') {
    const name = url.searchParams.get('ad') || '';
    if (!LOGO_RE.test(name) || !listDir(LOGO_DIR).includes(name)) fail(404, 'Logo bulunamadı (yalnızca panelden yüklenen logolar silinebilir)');
    fs.unlinkSync(path.join(LOGO_DIR, name));
    CFG.logolar = CFG.logolar.filter(f => f !== name);
    saveCfg(true);
  } else if (m === 'PUT' && p === 'logolar') {
    const { sira } = await readBody(req);
    CFG.logolar = Array.isArray(sira) ? sira.filter(f => typeof f === 'string' && LOGO_RE.test(f)) : [];
    saveCfg(true);
  } else if (m === 'GET' && p === 'yedek') {
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }).slice(0, 16).replace(' ', '_').replace(':', '');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="juri-yedek-${stamp}.json"`,
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify(backup(), null, 2));
  } else if (m === 'POST' && p === 'geri-yukle') {
    const skipped = restore(await readBody(req, 5e6));
    lastEvent = null; broadcast();
    return json(res, 200, { ...adminState(), atlanan: skipped });
  } else fail(404, 'Bulunamadı');

  broadcast();
  return json(res, 200, adminState());
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  try {
    if (url.pathname.startsWith('/api/admin/')) return await adminRoutes(req, res, url);

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const lim = loginLimited(req);
      const { username, password } = await readBody(req);
      const u = normalizeUser(username);
      if (JURY_NAME[u] && juryPasswordOk(u, password || '')) {
        lim.ok();
        return json(res, 200, { token: newSession(u, SESSION_TTL), user: u, name: JURY_NAME[u] });
      }
      lim.bad();
      return json(res, 401, { error: 'Kullanıcı adı veya şifre hatalı' });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) deleteSession.run(tokenHash(h.slice(7)));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, { ...state(), lastEvent: null });
    }

    if (req.method === 'GET' && url.pathname === '/api/durum') {
      return json(res, 200, { ok: true, event: CFG.event });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = auth(req);
      return user ? json(res, 200, { user }) : json(res, 401, { error: 'Oturum geçersiz' });
    }

    if (req.method === 'GET' && url.pathname === '/api/my-votes') {
      const user = auth(req);
      if (!user) return json(res, 401, { error: 'Oturum geçersiz' });
      return json(res, 200, {
        user, name: JURY_NAME[user], groups: GROUPS, teams: TEAMS, criteria: CRITERIA, votes: loadVotes()[user],
        event: CFG.event, oylamaAcik: CFG.oylamaAcik, surum: CFG.surum
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/vote') {
      const user = auth(req);
      if (!user) return json(res, 401, { error: 'Oturum geçersiz, tekrar giriş yapın' });
      if (!CFG.oylamaAcik) return json(res, 403, { error: 'Oylama şu anda kapalı' });
      const { group, scores, surum } = await readBody(req);
      // Form açıkken yönetici iller/kriterleri değiştirdiyse jüri güncel formu görmeden oy veremez
      if (surum !== undefined && surum !== CFG.surum) {
        return json(res, 409, { error: 'Değerlendirme ayarları güncellendi. Form yenilendi, puanları kontrol edip tekrar gönderin.', yenile: true });
      }
      if (!GROUPS.includes(group)) return json(res, 400, { error: 'Geçersiz grup' });
      const err = scoreError(scores);
      if (err) return json(res, 400, { error: err });
      const total = scores.reduce((a, b) => a + b, 0);
      const updated = !!selectExists.get(user, group);
      upsertVote.run(user, group, JSON.stringify(scores), total, Date.now());
      lastEvent = { id: Date.now(), jury: user, juryName: JURY_NAME[user], group, scores, total, updated };
      broadcast();
      return json(res, 200, { ok: true, total });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/vote') {
      const user = auth(req);
      if (!user) return json(res, 401, { error: 'Oturum geçersiz, tekrar giriş yapın' });
      if (!CFG.oylamaAcik) return json(res, 403, { error: 'Oylama şu anda kapalı' });
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

    // Logolar: önce panelden yüklenenler (data), sonra public/logolar.
    // SVG doğrudan açılırsa içindeki betik çalışmasın diye kısıtlı CSP ile verilir.
    if (req.method === 'GET' && url.pathname.startsWith('/logolar/')) {
      const name = decodeURIComponent(url.pathname.slice('/logolar/'.length));
      const dir = [LOGO_DIR, PUBLIC_LOGO_DIR].find(d => LOGO_RE.test(name) && listDir(d).includes(name));
      if (!dir) { res.writeHead(404); return res.end('Bulunamadı'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(name).toLowerCase()],
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff'
      });
      return fs.createReadStream(path.join(dir, name)).pipe(res);
    }

    if (req.method === 'GET') {
      const routes = { '/': '/ekran.html', '/juri': '/juri.html', '/sonuc': '/sonuc.html', '/yonetim': '/yonetim.html' };
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
    if (res.headersSent) return res.end();
    if (e.http) return json(res, e.http, { error: e.message, ...e.extra });
    console.error(e);
    json(res, 400, { error: 'Geçersiz istek' });
  }
});

if (!SECRETS.ortak && !process.env.JURI_SIFRE) {
  console.warn('Uyarı: ortak jüri şifresi yok (.env JURI_SIFRE ya da yönetim paneli). Özel şifresi olmayan jüriler giriş yapamaz.');
}
if (!adminConfigured()) {
  console.warn('Uyarı: ADMIN_SIFRE tanımlı değil; yönetim paneline giriş kapalı. .env dosyasına ekleyin.');
}

server.listen(PORT, HOST, () => {
  console.log(`\nJüri Değerlendirme Sistemi çalışıyor:`);
  console.log(`  Ana ekran (canlı sıralama): http://localhost:${PORT}/`);
  console.log(`  Jüri paneli               : http://localhost:${PORT}/juri`);
  console.log(`  Yönetim paneli            : http://localhost:${PORT}/yonetim`);
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
