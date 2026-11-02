require('dotenv').config();
const express = require('express');
const initSqlJs = require('sql.js');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'smartkeybox.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const adminUser = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET;
if (!adminPassword || adminPassword.length < 12) {
  console.error('ERROR: Set ADMIN_PASSWORD to a strong password of at least 12 characters in .env.'); process.exit(1);
}
if (!sessionSecret || sessionSecret.length < 32) {
  console.error('ERROR: Set SESSION_SECRET to a random secret of at least 32 characters in .env.'); process.exit(1);
}

// Cabinet access hours in Thailand: 07:00 inclusive to 19:00 exclusive.
// This is a server-side policy; physical ESP32 locks must enforce it independently.
const ACCESS_TIME_ZONE = 'Asia/Bangkok';
const ACCESS_START_MINUTES = 7 * 60;
const ACCESS_END_MINUTES = 19 * 60;
function accessWindow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ACCESS_TIME_ZONE, hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = Number(parts.find(p => p.type === 'minute').value);
  const currentMinutes = hour * 60 + minute;
  return { allowed: currentMinutes >= ACCESS_START_MINUTES && currentMinutes < ACCESS_END_MINUTES,
    timeZone: ACCESS_TIME_ZONE, open: '07:00', close: '19:00',
    currentTime: `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` };
}
function requireAccessHours(req, res, next) {
  const access = accessWindow();
  if (!access.allowed) return res.status(403).json({
    error: 'อยู่นอกเวลาให้บริการ เปิดตู้ได้เวลา 07:00–19:00 น.',
    code: 'OUTSIDE_ACCESS_HOURS', access
  });
  next();
}

function dateFmt(s) {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
}

(async () => {
  const SQL = await initSqlJs();
  let db = fs.existsSync(DB_FILE) ? new SQL.Database(new Uint8Array(fs.readFileSync(DB_FILE))) : new SQL.Database();
  let inTransaction = false;
  function saveDb() {
    if (!inTransaction) { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, Buffer.from(db.export())); fs.renameSync(tmp, DB_FILE); }
  }
  function params(args) { return args.length === 1 && Array.isArray(args[0]) ? args[0] : args; }
  const adapter = {
    exec(sql) { db.run(sql); saveDb(); },
    pragma(_s) {},
    prepare(sql) {
      return {
        get(...args) {
          const stmt = db.prepare(sql); try { stmt.bind(params(args)); return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
        },
        all(...args) {
          const stmt = db.prepare(sql); const out = []; try { stmt.bind(params(args)); while (stmt.step()) out.push(stmt.getAsObject()); return out; } finally { stmt.free(); }
        },
        run(...args) {
          db.run(sql, params(args)); const changes = db.getRowsModified(); const lastInsertRowid = db.exec('SELECT last_insert_rowid() AS id')[0]?.values?.[0]?.[0] || 0;
          saveDb(); return { lastInsertRowid, changes };
        }
      };
    },
    transaction(fn) { return (...args) => { db.run('BEGIN'); inTransaction = true; try { const result = fn(...args); db.run('COMMIT'); inTransaction = false; saveDb(); return result; } catch (e) { try { db.run('ROLLBACK'); } catch {} inTransaction = false; throw e; } }; }
  };
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ว่าง', holder TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, phone TEXT DEFAULT '', login_username TEXT UNIQUE, password_hash TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, key_id INTEGER NOT NULL REFERENCES keys(id), action TEXT NOT NULL CHECK(action IN ('ยืม','คืน')), note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), box_name TEXT NOT NULL DEFAULT 'Sports Equipment Box', location TEXT NOT NULL DEFAULT 'ห้องเก็บอุปกรณ์กีฬา', accent_color TEXT NOT NULL DEFAULT '#1769aa', sidebar_color TEXT NOT NULL DEFAULT '#102f55');
    INSERT OR IGNORE INTO settings(id,box_name,location,accent_color,sidebar_color) VALUES (1,'Sports Equipment Box','ห้องเก็บอุปกรณ์กีฬา','#1769aa','#102f55');
  `);
  adapter.exec(`CREATE TABLE IF NOT EXISTS access_control (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL DEFAULT 'auto', expires_at TEXT);
    INSERT OR IGNORE INTO access_control(id,mode,expires_at) VALUES(1,'auto',NULL);
    CREATE TABLE IF NOT EXISTS access_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_username TEXT NOT NULL, mode TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT);`);
  function cabinetAccess() {
    const base = accessWindow();
    const row = adapter.prepare('SELECT mode,expires_at FROM access_control WHERE id=1').get();
    let mode = row.mode;
    if (mode === 'override' && (!row.expires_at || Date.parse(row.expires_at) <= Date.now())) {
      adapter.prepare("UPDATE access_control SET mode='auto',expires_at=NULL WHERE id=1").run();
      mode = 'auto';
    }
    return { ...base, mode, allowed: mode === 'override' ? true : mode === 'off' ? false : base.allowed,
      expiresAt: mode === 'override' ? row.expires_at : null };
  }
  function requireCabinetAccess(req,res,next) {
    const access = cabinetAccess();
    if (!access.allowed) return res.status(403).json({ error: 'ตู้ปิดใช้งานในขณะนี้ กรุณาติดต่อผู้ดูแลระบบ', code: 'CABINET_CLOSED', access });
    next();
  }
  // Migrate older SQLite files without removing existing borrower records.
  const userCols = adapter.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('login_username')) adapter.exec('ALTER TABLE users ADD COLUMN login_username TEXT');
  if (!userCols.includes('password_hash')) adapter.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!userCols.includes('active')) adapter.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  if (!userCols.includes('fingerprint_registered')) adapter.exec('ALTER TABLE users ADD COLUMN fingerprint_registered INTEGER NOT NULL DEFAULT 0');
  try { adapter.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_username ON users(login_username)'); } catch {}

  const keyCols = adapter.prepare('PRAGMA table_info(keys)').all().map(c=>c.name);
  if (!keyCols.includes('total_qty')) adapter.exec('ALTER TABLE keys ADD COLUMN total_qty INTEGER NOT NULL DEFAULT 1');
  if (!keyCols.includes('available_qty')) adapter.exec('ALTER TABLE keys ADD COLUMN available_qty INTEGER NOT NULL DEFAULT 1');
  adapter.exec(`CREATE TABLE IF NOT EXISTS equipment_loans (id INTEGER PRIMARY KEY AUTOINCREMENT, key_id INTEGER NOT NULL, username TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), remaining INTEGER NOT NULL CHECK(remaining>=0), borrowed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  if (!adapter.prepare('SELECT COUNT(*) AS n FROM keys').get().n) {
    const ins = adapter.prepare('INSERT INTO keys(name,total_qty,available_qty) VALUES (?,?,?)');
    [['ไม้แบดมินตัน',10],['วอลเลย์บอล',2],['ฟุตบอล',1],['เปตอง (ชุด)',2]].forEach(([n,q])=>ins.run(n,q,q));
  }
  // Existing deployments keep their equipment and borrowing history intact.
  if (!adapter.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
    const ins = adapter.prepare('INSERT INTO users(user_code,name,phone) VALUES (?,?,?)');
    [['U001','นายสมชาย ใจดี','081-234-5678'],['U002','นางสาวสุดา มั่นคง','082-345-6789'],['U003','นายอนุชา ขยันเรียน','083-456-7890']].forEach(u => ins.run(...u));
  }
  saveDb();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '30kb' }));
  app.use(session({ secret: sessionSecret, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 } }));
  app.use(express.static(path.join(__dirname, 'public')));
  // Public, read-only status page. It exposes current borrower names and recent borrow/return history as requested.
  app.get('/status', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));
  app.get('/api/public/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const keys = adapter.prepare('SELECT id,name,status,holder,total_qty,available_qty FROM keys ORDER BY id').all();
    const history = adapter.prepare('SELECT logs.id, logs.username, logs.action, logs.created_at, keys.name AS key_name FROM logs JOIN keys ON keys.id=logs.key_id ORDER BY logs.id DESC LIMIT 50').all().map(r => ({ ...r, time: dateFmt(r.created_at) }));
    res.json({ keys, history, access: cabinetAccess(), updatedAt: new Date().toISOString() });
  });
  const requireAuth = (req, res, next) => req.session?.authenticated ? next() : res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  const requireAdmin = (req, res, next) => req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'ต้องใช้บัญชีผู้ดูแลระบบ' });
  const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  const verifyPassword = (password, stored) => {
    if (!stored || typeof password !== 'string') return false;
    const [salt, hex] = stored.split(':'); if (!salt || !hex) return false;
    const actual = crypto.scryptSync(password, salt, 64); const expected = Buffer.from(hex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
  app.get('/api/session', (req, res) => res.json({ authenticated: !!req.session?.authenticated, username: req.session?.user || '', role: req.session?.role || '' }));
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    let role = '', displayName = username;
    if (username === adminUser && password === adminPassword) role = 'admin';
    else {
      const account = adapter.prepare('SELECT id,name,login_username,password_hash,active FROM users WHERE login_username=?').get(username.trim());
      if (account && account.active === 1 && verifyPassword(password, account.password_hash)) { role = 'user'; displayName = account.name; }
    }
    if (!role) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือบัญชียังไม่ได้เปิดใช้งาน' });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'เริ่มเซสชันไม่สำเร็จ' });
      req.session.authenticated = true; req.session.user = username.trim(); req.session.displayName = displayName; req.session.role = role;
      req.session.save(err => { if (err) return res.status(500).json({ error: 'บันทึกเซสชันไม่สำเร็จ' }); res.json({ message: 'เข้าสู่ระบบสำเร็จ', role, displayName }); });
    });
  });
  app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ message: 'ออกจากระบบแล้ว' })));
  app.use('/api', requireAuth);
  app.get('/api/access-hours', (_req, res) => res.json(cabinetAccess()));
  app.get('/api/admin/access-control', requireAdmin, (_req,res) => res.json(cabinetAccess()));
  app.put('/api/admin/access-control', requireAdmin, (req,res) => {
    const mode = req.body?.mode;
    if (!['auto','override','off'].includes(mode)) return res.status(400).json({error:'โหมดไม่ถูกต้อง'});
    const expiresAt = mode === 'override' ? new Date(Date.now() + 30*60*1000).toISOString() : null;
    adapter.transaction(() => {
      adapter.prepare('UPDATE access_control SET mode=?,expires_at=? WHERE id=1').run(mode,expiresAt);
      adapter.prepare('INSERT INTO access_audit(admin_username,mode,expires_at) VALUES(?,?,?)').run(req.session.user,mode,expiresAt);
    })();
    res.json(cabinetAccess());
  });
  app.get('/api/admin/access-audit', requireAdmin, (_req,res) => res.json(adapter.prepare('SELECT admin_username,mode,changed_at,expires_at FROM access_audit ORDER BY id DESC LIMIT 30').all()));
  app.get('/api/keys', (req, res) => res.json(adapter.prepare('SELECT * FROM keys ORDER BY id').all()));
  app.post('/api/keys', requireAdmin, (req, res) => {
    const { name, quantity = 1 } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) return res.status(400).json({ error: 'กรุณาระบุชื่ออุปกรณ์ไม่เกิน 120 ตัวอักษร' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return res.status(400).json({error:'จำนวนไม่ถูกต้อง'});
    try { const info = adapter.prepare("INSERT INTO keys(name,status,holder,total_qty,available_qty) VALUES (?,'ว่าง','',?,?)").run(name.trim(),quantity,quantity); res.status(201).json({ id: info.lastInsertRowid, name: name.trim(), status: 'ว่าง', holder: '', total_qty:quantity,available_qty:quantity }); }
    catch { res.status(400).json({ error: 'เพิ่มช่องอุปกรณ์ไม่สำเร็จ' }); }
  });
  app.put('/api/keys/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id), { name } = req.body || {};
    if (!Number.isInteger(id) || id < 1 || typeof name !== 'string' || !name.trim() || name.trim().length > 120) return res.status(400).json({ error: 'กรุณาระบุชื่ออุปกรณ์ไม่เกิน 120 ตัวอักษร' });
    const result = adapter.prepare('UPDATE keys SET name=? WHERE id=?').run(name.trim(), id);
    if (!result.changes) return res.status(404).json({ error: 'ไม่พบช่องอุปกรณ์' });
    res.json({ message: 'แก้ไขชื่ออุปกรณ์แล้ว' });
  });
  // Student records are managed by administrators; no student web login credentials are created.
  app.get('/api/users', (req, res) => {
    const cols = req.session.role === 'admin' ? 'id,user_code,name,phone,fingerprint_registered' : 'id,user_code,name,phone';
    res.json(adapter.prepare(`SELECT ${cols} FROM users WHERE active=1 ORDER BY id`).all());
  });
  app.post('/api/users', requireAdmin, (req, res) => {
    const { name, phone = '', studentId } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || typeof phone !== 'string' || !/^\d{10}$/.test(phone.trim()) || typeof studentId !== 'string' || !/^[a-zA-Z0-9_-]{2,30}$/.test(studentId.trim())) return res.status(400).json({ error: 'กรุณาตรวจสอบชื่อ รหัสนักศึกษา และเบอร์โทรศัพท์ (ต้องเป็นตัวเลข 10 หลัก)' });
    try {
      const info = adapter.prepare('INSERT INTO users(user_code,name,phone,login_username,password_hash,active,fingerprint_registered) VALUES (?,?,?,NULL,NULL,1,0)').run(studentId.trim(), name.trim(), phone.trim());
      res.status(201).json({ id: info.lastInsertRowid, user_code: studentId.trim(), name: name.trim(), phone: phone.trim(), fingerprint_registered: 0 });
    } catch { res.status(400).json({ error: 'เพิ่มนักศึกษาไม่สำเร็จ รหัสนักศึกษาอาจซ้ำ' }); }
  });
  app.put('/api/users/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id), { name, phone = '', studentId } = req.body || {};
    if (!Number.isInteger(id) || id < 1 || typeof name !== 'string' || !name.trim() || name.trim().length > 120 || typeof phone !== 'string' || !/^\d{10}$/.test(phone.trim()) || typeof studentId !== 'string' || !/^[a-zA-Z0-9_-]{2,30}$/.test(studentId.trim())) return res.status(400).json({ error: 'กรุณาตรวจสอบชื่อ รหัสนักศึกษา และเบอร์โทรศัพท์ (ต้องเป็นตัวเลข 10 หลัก)' });
    try {
      const result = adapter.prepare('UPDATE users SET user_code=?,name=?,phone=?,login_username=NULL,password_hash=NULL WHERE id=?').run(studentId.trim(), name.trim(), phone.trim(), id);
      if (!result.changes) return res.status(404).json({ error: 'ไม่พบนักศึกษา' });
      res.json({ message: 'บันทึกข้อมูลนักศึกษาแล้ว' });
    } catch { res.status(400).json({ error: 'บันทึกไม่สำเร็จ รหัสนักศึกษาอาจซ้ำ' }); }
  });
  // Status is a placeholder until trusted ESP32 enrollment verification is integrated.
  app.get('/api/settings', requireAdmin, (req, res) => res.json(adapter.prepare('SELECT box_name,location,accent_color,sidebar_color FROM settings WHERE id=1').get()));
  app.put('/api/settings', requireAdmin, (req, res) => {
    const { boxName, location = '', accentColor = '#1769aa', sidebarColor = '#102f55' } = req.body || {};
    const validColor = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
    if (typeof boxName !== 'string' || !boxName.trim() || boxName.trim().length > 80 || typeof location !== 'string' || location.length > 160 || !validColor(accentColor) || !validColor(sidebarColor)) return res.status(400).json({ error: 'กรุณาตรวจสอบชื่อ สถานที่ และสีที่เลือก' });
    adapter.prepare('UPDATE settings SET box_name=?,location=?,accent_color=?,sidebar_color=? WHERE id=1').run(boxName.trim(), location.trim(), accentColor, sidebarColor);
    res.json({ message: 'บันทึกการตั้งค่าแล้ว' });
  });
  app.get('/api/logs', (req, res) => {
    const rows = adapter.prepare(`SELECT logs.id,logs.username,logs.key_id,keys.name AS key_name,logs.action,logs.note,logs.created_at FROM logs JOIN keys ON keys.id=logs.key_id ORDER BY logs.id DESC`).all();
    res.json(rows.map(r => ({ ...r, time: dateFmt(r.created_at) })));
  });
  app.get('/api/loans', (_req,res)=>res.json(adapter.prepare(`SELECT l.id,l.key_id,l.username,l.quantity,l.remaining,l.borrowed_at,k.name AS equipment FROM equipment_loans l JOIN keys k ON k.id=l.key_id WHERE l.remaining>0 ORDER BY l.id DESC`).all()));
  app.post('/api/borrow', requireCabinetAccess, (req,res)=>{
    const {keyId,username,note='',quantity=1}=req.body||{};
    if(!Number.isInteger(keyId)||!Number.isInteger(quantity)||quantity<1||typeof username!=='string'||!username.trim()||typeof note!=='string')return res.status(400).json({error:'ข้อมูลการยืมไม่ถูกต้อง'});
    try { adapter.transaction(()=>{
      const k=adapter.prepare('SELECT * FROM keys WHERE id=?').get(keyId);
      if(!k)throw Error('ไม่พบอุปกรณ์');
      if(k.available_qty<quantity)throw Error('อุปกรณ์คงเหลือไม่เพียงพอ');
      if(!adapter.prepare('SELECT id FROM users WHERE name=?').get(username.trim()))throw Error('ไม่พบผู้ใช้งาน');
      adapter.prepare('INSERT INTO equipment_loans(key_id,username,quantity,remaining) VALUES(?,?,?,?)').run(keyId,username.trim(),quantity,quantity);
      const left=k.available_qty-quantity;
      adapter.prepare('UPDATE keys SET available_qty=?,status=?,holder=? WHERE id=?').run(left,left===0?'ถูกยืม':'ว่าง',left===0?username.trim():'',keyId);
      adapter.prepare("INSERT INTO logs(username,key_id,action,note) VALUES(?,?,'ยืม',?)").run(username.trim(),keyId,`จำนวน ${quantity} | ${note.trim()}`);
    })();res.json({message:'บันทึกการยืมสำเร็จ'}); }catch(e){res.status(400).json({error:e.message});}
  });
  app.post('/api/return/:id',requireCabinetAccess,(req,res)=>{
    const keyId=Number(req.params.id), loanId=Number(req.body?.loanId),quantity=Number(req.body?.quantity);
    if(!Number.isInteger(keyId)||!Number.isInteger(loanId)||!Number.isInteger(quantity)||quantity<1)return res.status(400).json({error:'ระบุรายการยืมและจำนวนคืนให้ถูกต้อง'});
    try {adapter.transaction(()=>{
      const loan=adapter.prepare('SELECT * FROM equipment_loans WHERE id=? AND key_id=?').get(loanId,keyId);
      if(!loan||loan.remaining<quantity)throw Error('จำนวนคืนเกินจำนวนที่ค้างยืม');
      const k=adapter.prepare('SELECT * FROM keys WHERE id=?').get(keyId);
      adapter.prepare('UPDATE equipment_loans SET remaining=? WHERE id=?').run(loan.remaining-quantity,loanId);
      const left=k.available_qty+quantity;
      adapter.prepare('UPDATE keys SET available_qty=?,status=?,holder=? WHERE id=?').run(left,left===0?'ถูกยืม':'ว่าง','',keyId);
      adapter.prepare("INSERT INTO logs(username,key_id,action,note) VALUES(?,?,'คืน',?)").run(loan.username,keyId,`คืนจำนวน ${quantity}`);
    })();res.json({message:'บันทึกการคืนสำเร็จ'});}catch(e){res.status(400).json({error:e.message});}
  });
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.listen(PORT, '0.0.0.0', () => console.log(`Sports Equipment Box listening on port ${PORT}; database: ${DB_FILE}`));
})().catch(err => { console.error('Failed to initialize SQLite database:', err); process.exit(1); });
