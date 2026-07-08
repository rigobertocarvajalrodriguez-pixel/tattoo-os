// NOTA DE SEGURIDAD: aquí existía `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` a nivel
// global, lo que desactivaba la verificación de certificados TLS para TODAS las conexiones
// salientes del proceso (no solo la base de datos), exponiendo al servidor a ataques
// man-in-the-middle en cualquier petición HTTPS. Se elimina: la conexión a PostgreSQL ya
// tiene su propia configuración `ssl:{rejectUnauthorized:false}` más abajo, limitada solo a
// esa conexión (necesaria para el pooler de Supabase/Render), que es lo único que lo requería.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'rigobertocarvajalrodriguez@gmail.com';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ══════════════════════════════════════════
// POSTGRESQL CONNECTION
// ══════════════════════════════════════════
var dbConfig;
if (process.env.DATABASE_URL) {
  // Render / Supabase connection string
  dbConfig = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
} else {
  // Local development
  dbConfig = {
    host:     process.env.PG_HOST || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DB   || 'tattoo_os',
    user:     process.env.PG_USER || 'postgres',
    password: process.env.PG_PASS || 'tattoo123',
  };
}
const db = new Pool(dbConfig);
// Sin esto, un corte de red pasajero en una conexión inactiva del pool (p.ej. ECONNABORTED)
// se propaga como excepción no capturada y tumba todo el proceso - recomendación oficial de pg.
db.on('error', function(err) { console.error('[DB] Error inesperado en el pool de conexiones:', err.message); });
db.connect()
  .then(function() { console.log('[DB] PostgreSQL conectado'); })
  .catch(function(e) { console.error('[DB] Error conexión PostgreSQL:', e.message); });

// Seguimiento de curación por WhatsApp: cola de mensajes programados (día 1 / día 3 tras completar cita)
db.query(`
  CREATE TABLE IF NOT EXISTS wa_followups (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id TEXT NOT NULL,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_name    TEXT NOT NULL,
    phone          TEXT NOT NULL,
    kind           TEXT NOT NULL,
    message        TEXT NOT NULL,
    scheduled_at   TIMESTAMPTZ NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    sent_at        TIMESTAMPTZ,
    error          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
  )
`).then(function() {
  return db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_followup_unique ON wa_followups(appointment_id, kind)');
}).catch(function(e) { console.error('[DB] Error creando wa_followups:', e.message); });

// Comisiones por artista, métodos de pago y ventas de mostrador (migración aditiva)
Promise.all([
  db.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS commission_pct NUMERIC DEFAULT 50'),
  db.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS artist_id INTEGER REFERENCES profiles(id)'),
  db.query("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_method TEXT DEFAULT ''"),
  db.query("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS balance_method TEXT DEFAULT ''"),
  db.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS balance_paid BOOLEAN DEFAULT FALSE'),
  db.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS balance_paid_at TIMESTAMPTZ'),
  db.query("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'variable'"),
]).then(function() {
  // expenses.id era UUID pero el frontend siempre asigna ids numéricos (expSeq++) — mismo
  // problema ya resuelto antes para appointments/clients; se corrige aquí igual.
  return db.query('ALTER TABLE expenses ALTER COLUMN id DROP DEFAULT');
}).then(function() {
  return db.query('ALTER TABLE expenses ALTER COLUMN id TYPE TEXT USING id::TEXT');
}).then(function() {
  console.log('[DB] Migración de comisiones/artistas aplicada');
}).catch(function(e) { console.error('[DB] Error en migración de comisiones:', e.message); });

// Aislamiento por perfil: contraseña propia por perfil + marca del perfil Administrador
// (el primer perfil creado en cada cuenta). Migración aditiva.
// password_plain: copia en texto plano a pedido explícito del dueño del estudio, para que
// el Administrador pueda ver/gestionar las contraseñas de sus propios artistas (no las de
// otras cuentas de la plataforma). password_hash sigue siendo lo único que se usa para
// verificar el acceso; password_plain es solo para mostrarla en el Panel de Administración.
Promise.all([
  db.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_hash TEXT'),
  db.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_plain TEXT'),
  db.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin_profile BOOLEAN NOT NULL DEFAULT FALSE'),
]).then(function() {
  console.log('[DB] Migración de aislamiento por perfil aplicada');
}).catch(function(e) { console.error('[DB] Error en migración de aislamiento por perfil:', e.message); });

// Fase F: mismo respaldo/aislamiento real que ya tienen citas/clientes/gastos, ahora también
// para Proyectos, Documentos y WhatsApp (hoy solo vivían en localStorage del navegador).
// projects.id llegaba como UUID pero el frontend siempre manda ids numéricos - mismo arreglo
// ya aplicado antes a appointments/clients/expenses.
db.query('ALTER TABLE projects ALTER COLUMN id DROP DEFAULT').then(function() {
  return db.query('ALTER TABLE projects ALTER COLUMN id TYPE TEXT USING id::TEXT');
}).then(function() {
  return Promise.all([
    db.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT \'{}\''),
    db.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT \'{}\''),
    db.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wa_settings JSONB'),
    db.query(`CREATE TABLE IF NOT EXISTS doc_files (
      id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT DEFAULT '', client TEXT DEFAULT '', date TEXT DEFAULT '',
      size TEXT DEFAULT '', type TEXT DEFAULT '', url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW())`),
    db.query(`CREATE TABLE IF NOT EXISTS consents (
      id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_name TEXT DEFAULT '', dni TEXT DEFAULT '', dob TEXT DEFAULT '', phone TEXT DEFAULT '',
      email TEXT DEFAULT '', address TEXT DEFAULT '', tattoo_type TEXT DEFAULT '', zone TEXT DEFAULT '',
      size_desc TEXT DEFAULT '', session_date TEXT DEFAULT '', artist TEXT DEFAULT '',
      price TEXT DEFAULT '', deposit TEXT DEFAULT '', medical TEXT DEFAULT '',
      checks JSONB DEFAULT '[]', created_at_label TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW())`),
    db.query(`CREATE TABLE IF NOT EXISTS doc_templates (
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      template_id TEXT NOT NULL, name TEXT DEFAULT '', content TEXT DEFAULT '',
      PRIMARY KEY (profile_id, template_id))`),
    db.query(`CREATE TABLE IF NOT EXISTS wa_messages (
      id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL, text TEXT DEFAULT '', dir TEXT DEFAULT 'out', ts TIMESTAMPTZ,
      auto BOOLEAN DEFAULT FALSE, auto_id TEXT, read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW())`),
  ]);
}).then(function() {
  console.log('[DB] Migración de Proyectos/Documentos/WhatsApp (Fase F) aplicada');
}).catch(function(e) { console.error('[DB] Error en migración de Fase F:', e.message); });

db.query(`
  CREATE TABLE IF NOT EXISTS pos_sales (
    id          TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item        TEXT NOT NULL,
    amount      NUMERIC NOT NULL DEFAULT 0,
    method      TEXT DEFAULT 'efectivo',
    date        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).then(function() {
  return db.query('CREATE INDEX IF NOT EXISTS idx_pos_sales_user ON pos_sales(user_id)');
}).then(function() {
  // pos_sales.id se creó como UUID en el primer despliegue (Fase E); el frontend asigna
  // ids numéricos (posSaleSeq++), igual que en expenses — se corrige aquí también.
  return db.query('ALTER TABLE pos_sales ALTER COLUMN id DROP DEFAULT');
}).then(function() {
  return db.query('ALTER TABLE pos_sales ALTER COLUMN id TYPE TEXT USING id::TEXT');
}).catch(function(e) { console.error('[DB] Error creando pos_sales:', e.message); });

db.query(`
  CREATE TABLE IF NOT EXISTS commission_settlements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artist_id       INTEGER NOT NULL REFERENCES profiles(id),
    period_start    TEXT NOT NULL,
    period_end      TEXT NOT NULL,
    appt_ids        TEXT[] NOT NULL DEFAULT '{}',
    total_facturado NUMERIC NOT NULL DEFAULT 0,
    total_comision  NUMERIC NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    paid_at         TIMESTAMPTZ,
    method          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )
`).then(function() {
  return Promise.all([
    db.query('CREATE INDEX IF NOT EXISTS idx_settlements_artist ON commission_settlements(artist_id)'),
    db.query('CREATE INDEX IF NOT EXISTS idx_settlements_user ON commission_settlements(user_id)')
  ]);
}).catch(function(e) { console.error('[DB] Error creando commission_settlements:', e.message); });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Iconos PWA generados server-side como SVG → PNG equivalente
app.get('/icon-:size.png', function(req, res) {
  var size = parseInt(req.params.size) || 192;
  var r = Math.round(size * 0.22);
  var svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${r}" fill="#07070f"/>
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7c5cfc"/>
      <stop offset="100%" stop-color="#a78bfa"/>
    </linearGradient></defs>
    <text x="${size/2}" y="${size*0.58}" font-family="Arial Black,Arial" font-weight="900"
      font-size="${Math.round(size*0.52)}" text-anchor="middle" fill="url(#g)">T.</text>
  </svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// Sessions store: { userId: { client, qr, ready, state } }
const waSessions = {};

const SESSION_BASE = process.env.NODE_ENV === 'production' ? '/tmp/wa_sessions' : path.join(__dirname, 'data', 'wa_sessions');
if (!fs.existsSync(SESSION_BASE)) fs.mkdirSync(SESSION_BASE, { recursive: true });

// ══════════════════════════════════════════
// LOCAL DATA STORAGE
// ══════════════════════════════════════════
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch(e) { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Ensure admin user exists on first run (PostgreSQL)
db.query(
  'INSERT INTO users (email, name, password, is_admin) VALUES ($1,$2,$3,TRUE) ON CONFLICT (email) DO NOTHING',
  [ADMIN_EMAIL, 'Admin', ADMIN_PASS]
).then(function() {
  console.log('[AUTH] Admin verificado en BD:', ADMIN_EMAIL);
}).catch(function(e) {
  // Fallback: also keep JSON so app still works if DB is down
  var users = readJSON('users.json');
  if (!users.find(function(u) { return u.email === ADMIN_EMAIL; })) {
    users.push({ id: crypto.randomUUID(), email: ADMIN_EMAIL, name: 'Admin', password: ADMIN_PASS, isAdmin: true, created_at: new Date().toISOString() });
    writeJSON('users.json', users);
  }
});

// Migración de seguridad: las contraseñas de cuenta se guardaban en texto plano. Convertimos
// a hash bcrypt cualquier valor que todavía no tenga pinta de hash bcrypt (no empieza por
// $2a$/$2b$/$2y$), preservando el valor original para que cada usuario pueda seguir entrando
// con su misma contraseña de siempre - esto no resetea ninguna contraseña, solo cambia cómo
// se guarda. Aparte, si la del Admin seguía siendo el viejo valor por defecto "admin123", la
// rota a la nueva (ADMIN_PASS) ya hasheada, ya que esa sí era pública/adivinable.
var BCRYPT_RE = /^\$2[aby]\$/;
db.query('SELECT id, email, password FROM users').then(function(r) {
  var ops = r.rows.map(function(u) {
    var current = u.password || '';
    var toHash = (u.email === ADMIN_EMAIL && current === 'admin123') ? ADMIN_PASS : current;
    if (BCRYPT_RE.test(current) && toHash === current) return null; // ya migrada, nada que hacer
    return bcrypt.hash(toHash, 10).then(function(hash) {
      return db.query('UPDATE users SET password=$1 WHERE id=$2', [hash, u.id]);
    });
  }).filter(Boolean);
  return Promise.all(ops).then(function() {
    if (ops.length) console.log('[AUTH] Contraseñas migradas a bcrypt:', ops.length);
  });
}).catch(function(e) { console.error('[AUTH] Error migrando contraseñas a bcrypt:', e.message); });

// Auth sessions in memory: token → { userId, email, name, isAdmin }
const authSessions = {};

// ── AUTH ENDPOINTS ──
app.post('/api/auth/login', function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var pass = req.body.password || '';
  db.query('SELECT * FROM users WHERE email=$1', [email])
    .then(function(r) {
      if (!r.rows.length) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
      var user = r.rows[0];
      var stored = user.password || '';
      var check = BCRYPT_RE.test(stored) ? bcrypt.compare(pass, stored) : Promise.resolve(pass === stored);
      return check.then(function(match) {
        if (!match) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
        var token = crypto.randomUUID();
        authSessions[token] = { userId: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin };
        res.json({ token: token, user: { id: user.id, email: user.email, name: user.name } });
      });
    })
    .catch(function(e) { res.status(500).json({ error: 'Error de base de datos' }); });
});

app.post('/api/auth/register', function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var pass = req.body.password || '';
  var name = (req.body.name || email.split('@')[0]).trim();
  if (!email || !pass) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (pass.length < 8) return res.status(400).json({ error: 'Contraseña mínimo 8 caracteres' });
  bcrypt.hash(pass, 10).then(function(hash) {
    return db.query('INSERT INTO users (email, name, password) VALUES ($1,$2,$3) RETURNING *', [email, name, hash])
      .then(function(r) {
        var user = r.rows[0];
        var token = crypto.randomUUID();
        authSessions[token] = { userId: user.id, email: user.email, name: user.name, isAdmin: false };
        res.json({ token: token, user: { id: user.id, email: user.email, name: user.name } });
      });
  }).catch(function(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'El email ya está registrado' });
    res.status(500).json({ error: 'Error de base de datos' });
  });
});

app.get('/api/auth/me', function(req, res) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  var session = authSessions[token];
  if (!session) return res.status(401).json({ error: 'Token inválido' });
  res.json({ user: { id: session.userId, email: session.email, name: session.name } });
});

app.post('/api/auth/logout', function(req, res) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (token) delete authSessions[token];
  res.json({ ok: true });
});

// Get Chrome path based on environment
function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  // Linux (Render) - use bundled chromium from whatsapp-web.js
  if (process.platform === 'linux') return undefined; // let puppeteer find its own
  // Windows - prefer Chrome 119 which works with whatsapp-web.js
  if (process.platform === 'win32') {
    var userProfile = process.env.USERPROFILE || 'C:\\Users\\Usuario';
    var puppeteerCache = userProfile + '\\.cache\\puppeteer\\chrome';
    if (fs.existsSync(puppeteerCache)) {
      var versions = fs.readdirSync(puppeteerCache).sort();
      // Prefer version 119 first
      for (var i = 0; i < versions.length; i++) {
        if (versions[i].indexOf('119') !== -1) {
          var exePath = puppeteerCache + '\\' + versions[i] + '\\chrome-win64\\chrome.exe';
          if (fs.existsSync(exePath)) {
            console.log('[WA] Using Chrome 119:', exePath);
            return exePath;
          }
        }
      }
      // Fallback to oldest version (most compatible)
      for (var j = 0; j < versions.length; j++) {
        var exePath2 = puppeteerCache + '\\' + versions[j] + '\\chrome-win64\\chrome.exe';
        if (fs.existsSync(exePath2)) {
          console.log('[WA] Using Chrome:', exePath2);
          return exePath2;
        }
      }
    }
  }
  return undefined;
}

// Auth middleware
function authMiddleware(req, res, next) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  var session = authSessions[token];
  if (!session) return res.status(401).json({ error: 'Token invalido' });
  req.userId = session.userId;
  req.user = session;
  next();
}

// Admin middleware
function adminMiddleware(req, res, next) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  var session = authSessions[token];
  if (!session) return res.status(401).json({ error: 'Token inválido' });
  if (!session.isAdmin && session.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Not admin' });
  req.adminUser = session;
  next();
}

// Start WhatsApp session for a user
function startWASession(userId) {
  if (waSessions[userId] &&
      waSessions[userId].state !== 'ERROR' &&
      waSessions[userId].state !== 'DISCONNECTED') {
    console.log('[WA] Session already exists for:', userId.slice(0, 8), '- state:', waSessions[userId].state);
    return;
  }
  // Clear old session before starting new one
  if (waSessions[userId] && waSessions[userId].client) {
    try { waSessions[userId].client.destroy().catch(function(){}); } catch(e) {}
  }

  console.log('[WA] Starting session for:', userId.slice(0, 8));

  var sessionDir = path.join(SESSION_BASE, userId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  var chromePath = getChromePath();
  console.log('[WA] Chrome path:', chromePath || 'auto-detect');

  var clientOptions = {
    authStrategy: new LocalAuth({ dataPath: sessionDir, clientId: userId }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--ignore-certificate-errors'
      ],
      headless: true
    }
  };

  if (chromePath) clientOptions.puppeteer.executablePath = chromePath;

  var client = new Client(clientOptions);
  waSessions[userId] = { client: client, qr: null, ready: false, state: 'STARTING' };

  client.on('qr', function(qr) {
    console.log('[WA] QR ready for:', userId.slice(0, 8));
    waSessions[userId].state = 'QR_READY';
    qrcode.toDataURL(qr, function(err, url) {
      if (!err) waSessions[userId].qr = url;
    });
  });

  client.on('authenticated', function() {
    console.log('[WA] Authenticated:', userId.slice(0, 8));
    waSessions[userId].state = 'AUTHENTICATED';
    waSessions[userId].qr = null;
  });

  client.on('ready', function() {
    console.log('[WA] Ready:', userId.slice(0, 8));
    waSessions[userId].ready = true;
    waSessions[userId].state = 'READY';
  });

  client.on('disconnected', function(reason) {
    console.log('[WA] Disconnected:', userId.slice(0, 8), reason);
    if (waSessions[userId]) {
      waSessions[userId].ready = false;
      waSessions[userId].state = 'DISCONNECTED';
    }
  });

  client.initialize().catch(function(err) {
    console.error('[WA] Init error for', userId.slice(0, 8), ':', err.message);
    if (waSessions[userId]) {
      waSessions[userId].state = 'ERROR';
      waSessions[userId].ready = false;
      delete waSessions[userId];
    }
  });
}

// Health check
app.get('/health', function(req, res) {
  res.json({ status: 'ok', sessions: Object.keys(waSessions).length, platform: process.platform });
});

// Start WA session
app.post('/api/wa/start', authMiddleware, function(req, res) {
  startWASession(req.userId);
  res.json({ success: true });
});

// Get QR
app.get('/api/wa/qr', authMiddleware, function(req, res) {
  var session = waSessions[req.userId];
  if (!session) {
    startWASession(req.userId);
    return res.json({ status: 'starting', message: 'Iniciando... espera 15 segundos y pulsa Verificar.' });
  }
  if (session.ready) return res.json({ status: 'connected' });
  if (session.state === 'ERROR') {
    delete waSessions[req.userId];
    startWASession(req.userId);
    return res.json({ status: 'restarting', message: 'Reiniciando... espera 15 segundos.' });
  }
  if (session.qr) return res.json({ status: 'qr', qr: session.qr });
  res.json({ status: 'waiting', state: session.state, message: 'Generando QR... espera y pulsa Verificar.' });
});

// WA Status
app.get('/api/wa/status', authMiddleware, function(req, res) {
  var session = waSessions[req.userId];
  if (!session) return res.json({ connected: false, state: 'NOT_STARTED' });
  res.json({ connected: session.ready, state: session.state });
});

// Disconnect WA
app.post('/api/wa/disconnect', authMiddleware, async function(req, res) {
  var session = waSessions[req.userId];
  if (session && session.client) {
    try { await session.client.destroy(); } catch(e) {}
    delete waSessions[req.userId];
  }
  res.json({ success: true });
});

// Send message
app.post('/api/wa/send', authMiddleware, async function(req, res) {
  var session = waSessions[req.userId];
  if (!session || !session.ready) {
    return res.status(503).json({ error: 'WhatsApp no conectado. Ve a Ajustes > WhatsApp para vincular.' });
  }
  var numero = req.body.numero;
  var mensaje = req.body.mensaje;
  if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan numero y mensaje' });
  var num = numero.replace(/[\s+\-()]/g, '');
  if (num.length === 9) num = '34' + num;
  var chatId = num + '@c.us';
  try {
    await session.client.sendMessage(chatId, mensaje);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// DATA APIS — almacenamiento local JSON
// ══════════════════════════════════════════

// Clients API
app.get('/api/clients', authMiddleware, function(req, res) {
  var all = readJSON('clients.json');
  res.json(all.filter(function(c) { return c.user_id === req.userId; }).sort(function(a, b) { return b.created_at > a.created_at ? 1 : -1; }));
});
app.post('/api/clients', authMiddleware, function(req, res) {
  var all = readJSON('clients.json');
  var item = Object.assign({}, req.body, { id: crypto.randomUUID(), user_id: req.userId, created_at: new Date().toISOString() });
  all.push(item);
  writeJSON('clients.json', all);
  res.json(item);
});
app.put('/api/clients/:id', authMiddleware, function(req, res) {
  var all = readJSON('clients.json');
  var idx = all.findIndex(function(c) { return c.id === req.params.id && c.user_id === req.userId; });
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  all[idx] = Object.assign(all[idx], req.body);
  writeJSON('clients.json', all);
  res.json(all[idx]);
});
app.delete('/api/clients/:id', authMiddleware, function(req, res) {
  var all = readJSON('clients.json');
  writeJSON('clients.json', all.filter(function(c) { return !(c.id === req.params.id && c.user_id === req.userId); }));
  res.json({ success: true });
});

// Appointments API
app.get('/api/appointments', authMiddleware, function(req, res) {
  var all = readJSON('appointments.json');
  res.json(all.filter(function(a) { return a.user_id === req.userId; }).sort(function(a, b) { return a.date > b.date ? 1 : -1; }));
});
app.post('/api/appointments', authMiddleware, function(req, res) {
  var all = readJSON('appointments.json');
  var item = Object.assign({}, req.body, { id: crypto.randomUUID(), user_id: req.userId, created_at: new Date().toISOString() });
  all.push(item);
  writeJSON('appointments.json', all);
  res.json(item);
});
app.put('/api/appointments/:id', authMiddleware, function(req, res) {
  var all = readJSON('appointments.json');
  var idx = all.findIndex(function(a) { return a.id === req.params.id && a.user_id === req.userId; });
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  all[idx] = Object.assign(all[idx], req.body);
  writeJSON('appointments.json', all);
  res.json(all[idx]);
});
app.delete('/api/appointments/:id', authMiddleware, function(req, res) {
  var all = readJSON('appointments.json');
  writeJSON('appointments.json', all.filter(function(a) { return !(a.id === req.params.id && a.user_id === req.userId); }));
  res.json({ success: true });
});

// Expenses API
app.get('/api/expenses', authMiddleware, function(req, res) {
  var all = readJSON('expenses.json');
  res.json(all.filter(function(e) { return e.user_id === req.userId; }).sort(function(a, b) { return b.date > a.date ? 1 : -1; }));
});
app.post('/api/expenses', authMiddleware, function(req, res) {
  var all = readJSON('expenses.json');
  var item = Object.assign({}, req.body, { id: crypto.randomUUID(), user_id: req.userId, created_at: new Date().toISOString() });
  all.push(item);
  writeJSON('expenses.json', all);
  res.json(item);
});
app.delete('/api/expenses/:id', authMiddleware, function(req, res) {
  var all = readJSON('expenses.json');
  writeJSON('expenses.json', all.filter(function(e) { return !(e.id === req.params.id && e.user_id === req.userId); }));
  res.json({ success: true });
});

// ══════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════

app.get('/api/admin/users', adminMiddleware, function(req, res) {
  db.query('SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at ASC')
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/admin/tickets', adminMiddleware, function(req, res) {
  db.query('SELECT * FROM tickets ORDER BY updated_at DESC')
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.patch('/api/admin/tickets/:id', adminMiddleware, function(req, res) {
  var b = req.body;
  db.query('UPDATE tickets SET status=COALESCE($1,status), updated_at=NOW() WHERE id=$2 RETURNING *',
    [b.status, req.params.id])
    .then(function(r) { r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'No encontrado' }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/tickets/:id/messages', authMiddleware, function(req, res) {
  db.query('SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC', [req.params.id])
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/tickets/:id/messages', authMiddleware, function(req, res) {
  var isAdm = req.body.sender === 'admin';
  var sender = isAdm ? 'admin' : 'user';
  var senderName = isAdm ? 'Admin' : (req.body.sender_name || '');
  db.query('INSERT INTO ticket_messages (ticket_id,sender,sender_name,message) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.id, sender, senderName, req.body.message])
    .then(function(r) {
      var newStatus = isAdm ? 'in_progress' : 'open';
      db.query('UPDATE tickets SET status=$1, updated_at=NOW(), has_unread=$2 WHERE id=$3',
        [newStatus, !isAdm, req.params.id]).catch(function(){});
      res.json(r.rows[0]);
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/tickets/mine', authMiddleware, function(req, res) {
  db.query('SELECT * FROM tickets WHERE user_id=$1 ORDER BY updated_at DESC', [req.userId])
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.patch('/api/tickets/:id/read', authMiddleware, function(req, res) {
  db.query('UPDATE tickets SET has_unread=FALSE WHERE id=$1 AND user_id=$2', [req.params.id, req.userId])
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/tickets', authMiddleware, function(req, res) {
  db.query('INSERT INTO tickets (user_id,user_email,user_name,title,description,priority) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.userId, req.body.user_email, req.body.user_name, req.body.title, req.body.description, req.body.priority||'normal'])
    .then(function(r) { res.json(r.rows[0]); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// ══════════════════════════════════════════
// SEGUIMIENTO DE CURACIÓN POR WHATSAPP (día 1 / día 3 tras completar la cita)
// ══════════════════════════════════════════
var DEFAULT_FOLLOWUP_TEMPLATES = {
  day1: 'Hola {nombre}! ¿Qué tal fue todo en la sesión de tu "{tattoo}"? \n\nTe dejo los cuidados para la curación:\n- Lava la zona con agua y jabón neutro 2 veces al día\n- Aplica una crema cicatrizante fina, sin tapar en exceso\n- No rasques ni arranques las pieles que se levanten\n- Evita el sol directo, la piscina, el mar y la sauna las próximas 2-3 semanas\n- Usa ropa holgada que no roce la zona\n\n¡Cualquier duda me escribes!',
  day3: 'Hola {nombre}! ¿Cómo va la curación de tu "{tattoo}"? \n\nSi puedes, mándame una foto para ver cómo va el proceso y así confirmamos que todo evoluciona bien.\n\n¡Gracias!'
};

function followupFirstName(name) {
  return (name || '').trim().split(' ')[0] || '';
}

function renderFollowupTemplate(tpl, vars) {
  return String(tpl || '')
    .replace(/{nombre}/g, vars.nombre || '')
    .replace(/{tattoo}/g, vars.tattoo || 'tatuaje')
    .replace(/{fecha}/g, vars.fecha || '')
    .replace(/{precio}/g, vars.precio || '0')
    .replace(/{senal}/g, vars.senal || '0');
}

function followupDate(dateStr, daysAhead, hour) {
  var d = new Date(dateStr + 'T' + (hour || 11) + ':00:00');
  if (isNaN(d.getTime())) d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d;
}

// Called when an appointment transitions to status='completed': schedules the day1/day3 messages
function scheduleAftercareFollowups(userId, apptId, a, profile) {
  var clientsList = profile.clients || [];
  var client = clientsList.find(function(c) { return c.name === a.name; });
  var phone = client && client.phone ? String(client.phone).trim() : '';
  if (!phone) return Promise.resolve();

  var ws = profile.waSettings || {};
  if (ws.enabled === false) return Promise.resolve();
  var autos = ws.automations || [];
  var day1Auto = autos.find(function(x) { return x.id === 'followup_48h'; });
  var day3Auto = autos.find(function(x) { return x.id === 'followup_week'; });

  var vars = {
    nombre: followupFirstName(a.name),
    tattoo: a.workType || a.type || a.notes || a.note || 'tatuaje',
    fecha: a.date || '',
    precio: a.price || 0,
    senal: a.deposit || 0
  };

  var jobs = [];
  if (!day1Auto || day1Auto.enabled !== false) {
    var msg1 = renderFollowupTemplate(day1Auto ? day1Auto.template : DEFAULT_FOLLOWUP_TEMPLATES.day1, vars);
    jobs.push(db.query(
      'INSERT INTO wa_followups (appointment_id,user_id,client_name,phone,kind,message,scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (appointment_id,kind) DO NOTHING',
      [apptId, userId, a.name || '', phone, 'day1', msg1, followupDate(a.date, 1, 11)]
    ));
  }
  if (!day3Auto || day3Auto.enabled !== false) {
    var msg3 = renderFollowupTemplate(day3Auto ? day3Auto.template : DEFAULT_FOLLOWUP_TEMPLATES.day3, vars);
    jobs.push(db.query(
      'INSERT INTO wa_followups (appointment_id,user_id,client_name,phone,kind,message,scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (appointment_id,kind) DO NOTHING',
      [apptId, userId, a.name || '', phone, 'day3', msg3, followupDate(a.date, 3, 11)]
    ));
  }
  return Promise.all(jobs).catch(function() {});
}

// Background worker: envía los seguimientos programados que ya tocan, cuando WhatsApp está conectado
setInterval(function() {
  db.query("SELECT * FROM wa_followups WHERE status='pending' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT 20")
    .then(function(r) {
      r.rows.forEach(function(f) {
        var session = waSessions[f.user_id];
        if (!session || !session.ready) return; // se reintenta en el siguiente ciclo
        var num = f.phone.replace(/[\s+\-()]/g, '');
        if (num.length === 9) num = '34' + num;
        session.client.sendMessage(num + '@c.us', f.message)
          .then(function() {
            return db.query("UPDATE wa_followups SET status='sent', sent_at=NOW() WHERE id=$1", [f.id]);
          })
          .catch(function(e) {
            db.query("UPDATE wa_followups SET status='failed', error=$1 WHERE id=$2", [e.message, f.id]).catch(function() {});
          });
      });
    })
    .catch(function() {});
}, 5 * 60 * 1000);

// Consulta de seguimientos programados/enviados (para mostrar en Ajustes > WhatsApp)
app.get('/api/wa/followups', authMiddleware, function(req, res) {
  db.query('SELECT id,client_name,kind,status,scheduled_at,sent_at FROM wa_followups WHERE user_id=$1 ORDER BY scheduled_at DESC LIMIT 100', [req.userId])
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Profile sync: save full profile data to PostgreSQL
app.post('/api/profile/sync', authMiddleware, function(req, res) {
  var userId = req.userId;
  var profilesData = req.body.profiles;
  var posSalesData = req.body.posSales || [];
  if (!profilesData || !profilesData.length) return res.json({ ok: true });

  // El perfil Administrador es el primero que existió para esta cuenta (id más bajo ya
  // guardado en la BD); si es la primerísima sincronización, es el id más bajo de este envío.
  db.query('SELECT id FROM profiles WHERE user_id=$1 ORDER BY id ASC LIMIT 1', [userId]).then(function(existingFirst) {
    var adminId = existingFirst.rows.length
      ? existingFirst.rows[0].id
      : Math.min.apply(null, profilesData.map(function(p) { return p.id; }));

    var ops = profilesData.map(function(p) {
      return db.query(
        'INSERT INTO profiles (id,user_id,name,role,color,commission_pct,is_admin_profile,wa_settings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET name=$3,role=$4,color=$5,commission_pct=$6,is_admin_profile=$7,wa_settings=$8',
        [p.id, userId, p.name||'', p.role||'', p.color||'v', typeof p.commissionPct==='number'?p.commissionPct:50, p.id === adminId, p.waSettings ? JSON.stringify(p.waSettings) : null]
      ).then(function() {
        var apptOps = (p.appts||[]).map(function(a) {
          var apptId = a.id !== undefined && a.id !== null ? String(a.id) : crypto.randomUUID();
          return db.query('SELECT status FROM appointments WHERE id=$1', [apptId]).then(function(prev) {
            var oldStatus = prev.rows.length ? prev.rows[0].status : null;
            return db.query(
              'INSERT INTO appointments (id,profile_id,user_id,name,date,start,dur,color,status,price,deposit,work_type,notes,artist_id,deposit_method,balance_method,balance_paid,balance_paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (id) DO UPDATE SET name=$4,date=$5,start=$6,dur=$7,color=$8,status=$9,price=$10,deposit=$11,work_type=$12,notes=$13,artist_id=$14,deposit_method=$15,balance_method=$16,balance_paid=$17,balance_paid_at=$18',
              [apptId, p.id, userId, a.name||'', a.date||'', a.start||10, a.dur||2, a.color||'v', a.status||'pending', a.price||0, a.deposit||0, a.workType||a.type||'', a.notes||a.note||'', a.artistId||p.id, a.depositMethod||'', a.balanceMethod||'', !!a.balancePaid, a.balancePaidDate||null]
            ).then(function() {
              if (oldStatus !== 'completed' && a.status === 'completed') {
                return scheduleAftercareFollowups(userId, apptId, a, p);
              }
            });
          }).catch(function(){});
        });
        var clientOps = (p.clients||[]).map(function(c) {
          var clientId = c.id !== undefined && c.id !== null ? String(c.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO clients (id,profile_id,user_id,name,phone,email,instagram,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET name=$4,phone=$5,email=$6,instagram=$7,notes=$8',
            [clientId, p.id, userId, c.name||'', c.phone||'', c.email||'', c.instagram||'', c.notes||'']
          ).catch(function(){});
        });
        var expenseOps = (p.expenses||[]).map(function(ex) {
          var expId = ex.id !== undefined && ex.id !== null ? String(ex.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO expenses (id,profile_id,user_id,amount,category,description,date,kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET amount=$4,category=$5,description=$6,date=$7,kind=$8',
            [expId, p.id, userId, ex.amount||0, ex.cat||'', ex.name||'', ex.date||'', ex.kind||'variable']
          ).catch(function(){});
        });
        // Fase F: Proyectos, Documentos y WhatsApp - mismo respaldo real que ya tienen
        // citas/clientes/gastos, para que sobrevivan aunque se borre este navegador.
        var projectOps = (p.projects||[]).map(function(pr) {
          var prId = pr.id !== undefined && pr.id !== null ? String(pr.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO projects (id,profile_id,user_id,name,client,notes,tags,images) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET name=$4,client=$5,notes=$6,tags=$7,images=$8',
            [prId, p.id, userId, pr.name||'', pr.client||'', pr.notes||'', pr.tags||[], pr.images||[]]
          ).catch(function(){});
        });
        var docFileOps = (p.docFiles||[]).map(function(df) {
          var dfId = df.id !== undefined && df.id !== null ? String(df.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO doc_files (id,profile_id,user_id,name,client,date,size,type,url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET name=$4,client=$5,date=$6,size=$7,type=$8,url=$9',
            [dfId, p.id, userId, df.name||'', df.client||'', df.date||'', df.size||'', df.type||'', df.url||'']
          ).catch(function(){});
        });
        var consentOps = (p.consents||[]).map(function(cs) {
          var csId = cs.id !== undefined && cs.id !== null ? String(cs.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO consents (id,profile_id,user_id,client_name,dni,dob,phone,email,address,tattoo_type,zone,size_desc,session_date,artist,price,deposit,medical,checks,created_at_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (id) DO UPDATE SET client_name=$4,dni=$5,dob=$6,phone=$7,email=$8,address=$9,tattoo_type=$10,zone=$11,size_desc=$12,session_date=$13,artist=$14,price=$15,deposit=$16,medical=$17,checks=$18,created_at_label=$19',
            [csId, p.id, userId, cs.clientName||'', cs.dni||'', cs.dob||'', cs.phone||'', cs.email||'', cs.address||'', cs.tattooType||'', cs.zone||'', cs.size||'', cs.sessionDate||'', cs.artist||'', cs.price||'', cs.deposit||'', cs.medical||'', JSON.stringify(cs.checks||[]), cs.createdAt||'']
          ).catch(function(){});
        });
        var docTemplateOps = (p.docTemplates||[]).map(function(dt) {
          return db.query(
            'INSERT INTO doc_templates (profile_id,user_id,template_id,name,content) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (profile_id,template_id) DO UPDATE SET name=$4,content=$5',
            [p.id, userId, dt.id||'', dt.name||'', dt.content||'']
          ).catch(function(){});
        });
        var waMessageOps = [];
        Object.keys(p.waMessages||{}).forEach(function(clientId) {
          (p.waMessages[clientId]||[]).forEach(function(m) {
            var mId = m.id !== undefined && m.id !== null ? String(m.id) : crypto.randomUUID();
            waMessageOps.push(db.query(
              'INSERT INTO wa_messages (id,profile_id,user_id,client_id,text,dir,ts,auto,auto_id,read) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET text=$5,dir=$6,ts=$7,auto=$8,auto_id=$9,read=$10',
              [mId, p.id, userId, String(clientId), m.text||'', m.dir||'out', m.ts||new Date().toISOString(), !!m.auto, m.autoId||null, !!m.read]
            ).catch(function(){}));
          });
        });
        return Promise.all(apptOps.concat(clientOps).concat(expenseOps).concat(projectOps).concat(docFileOps).concat(consentOps).concat(docTemplateOps).concat(waMessageOps));
      });
    });

    var posSaleOps = posSalesData.map(function(s) {
      var saleId = s.id !== undefined && s.id !== null ? String(s.id) : crypto.randomUUID();
      return db.query(
        'INSERT INTO pos_sales (id,user_id,item,amount,method,date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET item=$3,amount=$4,method=$5,date=$6',
        [saleId, userId, s.item||'', s.amount||0, s.method||'efectivo', s.date||'']
      ).catch(function(){});
    });

    return Promise.all(ops.concat(posSaleOps));
  })
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// ══════════════════════════════════════════
// AISLAMIENTO POR PERFIL: contraseña propia + datos con alcance real
// ══════════════════════════════════════════

// Le dice al frontend si este perfil ya tiene contraseña (para mostrar "crear" o "ingresar").
app.get('/api/profile/:id/has-password', authMiddleware, function(req, res) {
  var profileId = parseInt(req.params.id, 10);
  db.query('SELECT user_id, password_hash FROM profiles WHERE id=$1', [profileId])
    .then(function(r) {
      if (!r.rows.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      if (r.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'No autorizado' });
      res.json({ hasPassword: !!r.rows[0].password_hash });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Primer acceso a un perfil: define su contraseña. Accesos siguientes: la verifica.
// Todos los perfiles (incluido el Administrador) pasan por aquí — la única diferencia
// entre perfiles es qué datos ven después (ver /api/profile/:id/data), no cómo se autentican.
app.post('/api/profile/:id/auth', authMiddleware, function(req, res) {
  var profileId = parseInt(req.params.id, 10);
  var password = req.body.password || '';
  if (!password) return res.status(400).json({ error: 'Falta la contraseña' });

  db.query('SELECT id, user_id, password_hash, is_admin_profile FROM profiles WHERE id=$1', [profileId])
    .then(function(r) {
      if (!r.rows.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      var profile = r.rows[0];
      if (profile.user_id !== req.userId) return res.status(403).json({ error: 'No autorizado' });

      function unlock() {
        if (!req.user.unlockedProfiles) req.user.unlockedProfiles = {};
        req.user.unlockedProfiles[profileId] = true;
        res.json({ ok: true, isAdminProfile: !!profile.is_admin_profile });
      }

      if (!profile.password_hash) {
        // Primer acceso: esta contraseña queda establecida para este perfil.
        bcrypt.hash(password, 10).then(function(hash) {
          return db.query('UPDATE profiles SET password_hash=$1, password_plain=$2 WHERE id=$3', [hash, password, profileId]);
        }).then(unlock).catch(function(e) { res.status(500).json({ error: e.message }); });
      } else {
        bcrypt.compare(password, profile.password_hash).then(function(match) {
          if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });
          unlock();
        }).catch(function(e) { res.status(500).json({ error: e.message }); });
      }
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Datos de un perfil ya desbloqueado: Administrador ve todo (igual que hoy);
// un artista solo ve sus propias citas/clientes/gastos — filtrado aquí, en el servidor,
// para que los datos de otro artista nunca lleguen al navegador.
app.get('/api/profile/:id/data', authMiddleware, function(req, res) {
  var profileId = parseInt(req.params.id, 10);

  db.query('SELECT id, user_id, is_admin_profile FROM profiles WHERE id=$1', [profileId])
    .then(function(r) {
      if (!r.rows.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      var profile = r.rows[0];
      if (profile.user_id !== req.userId) return res.status(403).json({ error: 'No autorizado' });
      var unlocked = req.user.unlockedProfiles && req.user.unlockedProfiles[profileId];
      if (!unlocked) return res.status(403).json({ error: 'Perfil no desbloqueado en esta sesión' });

      return db.query('SELECT * FROM profiles WHERE user_id=$1 ORDER BY id ASC', [req.userId]).then(function(allProfiles) {
        var roster = allProfiles.rows.map(function(p) {
          return { id: p.id, name: p.name, role: p.role, color: p.color, isAdminProfile: !!p.is_admin_profile };
        });

        if (profile.is_admin_profile) {
          var profileIds = allProfiles.rows.map(function(p) { return p.id; });
          return Promise.all([
            db.query('SELECT * FROM appointments WHERE profile_id=ANY($1) ORDER BY date,start', [profileIds]),
            db.query('SELECT * FROM clients WHERE profile_id=ANY($1)', [profileIds]),
            db.query('SELECT * FROM expenses WHERE profile_id=ANY($1)', [profileIds]),
          ]).then(function(results) {
            res.json({ roster: roster, scope: 'admin', appointments: results[0].rows, clients: results[1].rows, expenses: results[2].rows });
          });
        } else {
          return Promise.all([
            db.query('SELECT * FROM appointments WHERE profile_id=$1 ORDER BY date,start', [profileId]),
            db.query('SELECT * FROM clients WHERE profile_id=$1', [profileId]),
            db.query('SELECT * FROM expenses WHERE profile_id=$1', [profileId]),
          ]).then(function(results) {
            res.json({ roster: roster, scope: 'own', appointments: results[0].rows, clients: results[1].rows, expenses: results[2].rows });
          });
        }
      });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Gestión de contraseñas de los ARTISTAS DEL PROPIO ESTUDIO (self-service): a pedido
// explícito del dueño, puede ver la contraseña en texto plano y restablecerla. Deliberadamente
// separado del panel de super-admin de la plataforma (adminMiddleware) - esto solo expone
// los perfiles de la propia cuenta autenticada, nunca los de otras cuentas/estudios.
app.get('/api/my-profiles/passwords', authMiddleware, function(req, res) {
  db.query('SELECT id, name, role, password_hash, password_plain, is_admin_profile FROM profiles WHERE user_id=$1 ORDER BY id ASC', [req.userId])
    .then(function(r) {
      res.json({ profiles: r.rows.map(function(p) {
        return { id: p.id, name: p.name, role: p.role, isAdminProfile: !!p.is_admin_profile, hasPassword: !!p.password_hash, password: p.password_plain || null };
      }) });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/my-profiles/:id/reset-password', authMiddleware, function(req, res) {
  var profileId = parseInt(req.params.id, 10);
  var newPassword = req.body.newPassword || '';
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });

  db.query('SELECT user_id FROM profiles WHERE id=$1', [profileId])
    .then(function(r) {
      if (!r.rows.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      if (r.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'No autorizado' });
      return bcrypt.hash(newPassword, 10).then(function(hash) {
        return db.query('UPDATE profiles SET password_hash=$1, password_plain=$2 WHERE id=$3', [hash, newPassword, profileId]);
      });
    })
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// ══════════════════════════════════════════
// FINANZAS: reportes y liquidaciones por artista
// ══════════════════════════════════════════

// Calcula [from,to] (YYYY-MM-DD, inclusive) a partir de period+date
function financePeriodRange(period, dateStr) {
  var d = new Date((dateStr || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
  if (isNaN(d.getTime())) d = new Date();
  function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function iso(y, m, day) { return y + '-' + pad(m + 1) + '-' + pad(day); }
  if (period === 'daily') {
    var s = iso(d.getFullYear(), d.getMonth(), d.getDate());
    return { from: s, to: s };
  }
  if (period === 'yearly') {
    return { from: d.getFullYear() + '-01-01', to: d.getFullYear() + '-12-31' };
  }
  // monthly (default)
  var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return { from: iso(d.getFullYear(), d.getMonth(), 1), to: iso(d.getFullYear(), d.getMonth(), lastDay) };
}

// Reporte de ingresos/gastos/comisiones para un periodo — solo requiere sesión iniciada
// (esta cuenta no distingue dueño/empleado todavía, igual que el resto de la app)
app.get('/api/finance/reports', authMiddleware, function(req, res) {
  var userId = req.userId;
  var range = financePeriodRange(req.query.period, req.query.date);
  var stripeFeePct = parseFloat(req.query.stripeFeePct);
  if (isNaN(stripeFeePct)) stripeFeePct = 1.5;

  Promise.all([
    db.query(
      "SELECT a.artist_id, p.name AS artist_name, p.commission_pct, COUNT(*) AS cnt, COALESCE(SUM(a.price),0) AS total_price, " +
      "COALESCE(SUM(CASE WHEN a.deposit_method='stripe' THEN a.deposit ELSE 0 END),0) AS stripe_deposit, " +
      "COALESCE(SUM(CASE WHEN a.balance_method='stripe' THEN a.price-a.deposit ELSE 0 END),0) AS stripe_balance " +
      "FROM appointments a LEFT JOIN profiles p ON p.id=a.artist_id " +
      "WHERE a.user_id=$1 AND a.status='completed' AND a.date>=$2 AND a.date<=$3 " +
      "GROUP BY a.artist_id, p.name, p.commission_pct",
      [userId, range.from, range.to]
    ),
    db.query('SELECT COALESCE(SUM(amount),0) AS total FROM pos_sales WHERE user_id=$1 AND date>=$2 AND date<=$3', [userId, range.from, range.to]),
    db.query(
      "SELECT kind, COALESCE(SUM(amount),0) AS total FROM expenses WHERE user_id=$1 AND date>=$2 AND date<=$3 GROUP BY kind",
      [userId, range.from, range.to]
    ),
    db.query(
      "SELECT COALESCE(SUM(total_comision),0) AS paid FROM commission_settlements WHERE user_id=$1 AND status='paid' AND period_start>=$2 AND period_end<=$3",
      [userId, range.from, range.to]
    ),
  ]).then(function(results) {
    var perArtist = results[0].rows.map(function(r) {
      var pct = r.commission_pct !== null ? Number(r.commission_pct) : 50;
      var totalFacturado = Number(r.total_price);
      var totalComision = totalFacturado * pct / 100;
      return {
        artistId: r.artist_id, name: r.artist_name || '(sin artista)', tattoos: Number(r.cnt),
        totalFacturado: totalFacturado, commissionPct: pct, totalComision: totalComision,
        stripeAmount: Number(r.stripe_deposit) + Number(r.stripe_balance)
      };
    });
    var tattooIncome = perArtist.reduce(function(s, a) { return s + a.totalFacturado; }, 0);
    var posIncome = Number(results[1].rows[0].total);
    var expensesByKind = { fijo: 0, variable: 0 };
    results[2].rows.forEach(function(r) { expensesByKind[r.kind || 'variable'] = Number(r.total); });
    var totalExpenses = expensesByKind.fijo + expensesByKind.variable;
    var totalCommissionAccrued = perArtist.reduce(function(s, a) { return s + a.totalComision; }, 0);
    var commissionPaid = Number(results[3].rows[0].paid);
    var stripeFees = perArtist.reduce(function(s, a) { return s + a.stripeAmount * stripeFeePct / 100; }, 0);
    var netProfit = (tattooIncome + posIncome) - (commissionPaid + totalExpenses + stripeFees);
    res.json({
      range: range,
      income: { tattoos: tattooIncome, pos: posIncome, total: tattooIncome + posIncome },
      expenses: { fijo: expensesByKind.fijo, variable: expensesByKind.variable, total: totalExpenses },
      commissions: { perArtist: perArtist, totalAccrued: totalCommissionAccrued, totalPaid: commissionPaid, totalPending: totalCommissionAccrued - commissionPaid },
      stripeFees: stripeFees,
      netProfit: netProfit
    });
  }).catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Listar liquidaciones existentes
app.get('/api/finance/settlements', authMiddleware, function(req, res) {
  var conditions = ['user_id=$1'];
  var params = [req.userId];
  if (req.query.artistId) { params.push(req.query.artistId); conditions.push('artist_id=$' + params.length); }
  if (req.query.status) { params.push(req.query.status); conditions.push('status=$' + params.length); }
  db.query('SELECT * FROM commission_settlements WHERE ' + conditions.join(' AND ') + ' ORDER BY created_at DESC', params)
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Generar una liquidación real: calculada server-side desde appointments (fuente autoritativa)
app.post('/api/finance/settlements', authMiddleware, function(req, res) {
  var userId = req.userId;
  var artistId = parseInt(req.body.artistId, 10);
  var periodStart = req.body.periodStart, periodEnd = req.body.periodEnd;
  if (!artistId || !periodStart || !periodEnd) return res.status(400).json({ error: 'Faltan artistId, periodStart o periodEnd' });

  db.query('SELECT commission_pct FROM profiles WHERE id=$1 AND user_id=$2', [artistId, userId])
    .then(function(pr) {
      if (!pr.rows.length) return res.status(404).json({ error: 'Artista no encontrado' });
      var pct = pr.rows[0].commission_pct !== null ? Number(pr.rows[0].commission_pct) : 50;
      return db.query(
        "SELECT id, price FROM appointments WHERE user_id=$1 AND artist_id=$2 AND status='completed' AND date>=$3 AND date<=$4 " +
        "AND NOT (id = ANY(SELECT unnest(appt_ids) FROM commission_settlements WHERE artist_id=$2 AND user_id=$1))",
        [userId, artistId, periodStart, periodEnd]
      ).then(function(ar) {
        var apptIds = ar.rows.map(function(r) { return r.id; });
        var totalFacturado = ar.rows.reduce(function(s, r) { return s + Number(r.price); }, 0);
        var totalComision = totalFacturado * pct / 100;
        return db.query(
          'INSERT INTO commission_settlements (user_id,artist_id,period_start,period_end,appt_ids,total_facturado,total_comision) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [userId, artistId, periodStart, periodEnd, apptIds, totalFacturado, totalComision]
        );
      });
    })
    .then(function(r) { if (!res.headersSent) res.json(r.rows[0]); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Editar una liquidación (marcar pagada/pendiente, o corregir montos/periodo a mano)
app.patch('/api/finance/settlements/:id', authMiddleware, function(req, res) {
  var b = req.body;
  db.query('SELECT * FROM commission_settlements WHERE id=$1 AND user_id=$2', [req.params.id, req.userId])
    .then(function(existing) {
      if (!existing.rows.length) return res.status(404).json({ error: 'Liquidación no encontrada' });
      var row = existing.rows[0];
      var newStatus = b.status !== undefined ? b.status : row.status;
      var newPaidAt = row.paid_at;
      if (newStatus === 'paid' && row.status !== 'paid') newPaidAt = new Date();
      if (newStatus !== 'paid') newPaidAt = null;
      return db.query(
        'UPDATE commission_settlements SET status=$1, method=COALESCE($2,method), total_facturado=COALESCE($3,total_facturado), total_comision=COALESCE($4,total_comision), period_start=COALESCE($5,period_start), period_end=COALESCE($6,period_end), paid_at=$7 WHERE id=$8 AND user_id=$9 RETURNING *',
        [newStatus, b.method, b.totalFacturado, b.totalComision, b.periodStart, b.periodEnd, newPaidAt, req.params.id, req.userId]
      );
    })
    .then(function(r) { if (!res.headersSent) res.json(r.rows[0]); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Eliminar una liquidación
app.delete('/api/finance/settlements/:id', authMiddleware, function(req, res) {
  db.query('DELETE FROM commission_settlements WHERE id=$1 AND user_id=$2', [req.params.id, req.userId])
    .then(function() { res.json({ success: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Admin: get a specific user's full data from PostgreSQL
app.get('/api/admin/user-data/:userId', adminMiddleware, function(req, res) {
  var uid = req.params.userId;
  db.query('SELECT * FROM profiles WHERE user_id=$1 ORDER BY id ASC', [uid])
    .then(function(pr) {
      if (!pr.rows.length) return res.status(404).json({ error: 'Sin datos guardados aún' });
      var profileIds = pr.rows.map(function(p){ return p.id; });
      return Promise.all([
        db.query('SELECT * FROM appointments WHERE profile_id=ANY($1) ORDER BY date,start', [profileIds]),
        db.query('SELECT * FROM clients WHERE profile_id=ANY($1)', [profileIds])
      ]).then(function(results) {
        var appts = results[0].rows;
        var clients = results[1].rows;
        var profiles = pr.rows.map(function(p) {
          return Object.assign({}, p, {
            appts: appts.filter(function(a){ return a.profile_id===p.id; }),
            clients: clients.filter(function(c){ return c.profile_id===p.id; })
          });
        });
        res.json({ profiles: profiles, updated_at: new Date().toISOString() });
      });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Keep-alive for Render free plan
if (process.env.NODE_ENV === 'production' && process.env.RENDER_URL) {
  setInterval(function() {
    fetch(process.env.RENDER_URL + '/health').catch(function() {});
  }, 10 * 60 * 1000);
}

// ══════════════════════════════════════════
// WEBRTC SIGNALING (Socket.io)
// ══════════════════════════════════════════
const http = require('http');
const { Server } = require('socket.io');
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// rooms: { roomId: { admin: socketId, user: socketId, userId: string } }
const rooms = {};

io.on('connection', function(socket) {
  // Admin solicita ver la pantalla de un usuario
  socket.on('admin:request-view', function(data) {
    rooms[data.roomId] = { admin: socket.id, userId: data.targetUserId };
    io.to('user:' + data.targetUserId).emit('view:request', { roomId: data.roomId, adminName: 'Admin' });
  });

  socket.on('user:join', function(data) {
    socket.join('user:' + data.userId);
    socket.userId = data.userId;
  });

  socket.on('view:accept', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    room.user = socket.id;
    socket.join(data.roomId);
    io.to(room.admin).emit('view:accepted', { roomId: data.roomId });
  });
  socket.on('view:reject', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    io.to(room.admin).emit('view:rejected', { roomId: data.roomId });
    delete rooms[data.roomId];
  });

  socket.on('webrtc:offer', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    io.to(room.user).emit('webrtc:offer', { offer: data.offer, roomId: data.roomId });
  });
  socket.on('webrtc:answer', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    io.to(room.admin).emit('webrtc:answer', { answer: data.answer, roomId: data.roomId });
  });
  socket.on('webrtc:ice', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    var target = socket.id === room.admin ? room.user : room.admin;
    io.to(target).emit('webrtc:ice', { candidate: data.candidate });
  });

  socket.on('view:end', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    io.to(room.admin).emit('view:ended');
    io.to(room.user).emit('view:ended');
    delete rooms[data.roomId];
  });

  socket.on('disconnect', function() {
    Object.keys(rooms).forEach(function(rid) {
      var r = rooms[rid];
      if (r.admin === socket.id || r.user === socket.id) {
        io.to(r.admin).emit('view:ended');
        io.to(r.user || '').emit('view:ended');
        delete rooms[rid];
      }
    });
  });
});

httpServer.listen(PORT, '0.0.0.0', function() {
  var os = require('os');
  var nets = os.networkInterfaces();
  var localIP = 'localhost';
  Object.keys(nets).forEach(function(name) {
    nets[name].forEach(function(net) {
      if (net.family === 'IPv4' && !net.internal) localIP = net.address;
    });
  });
  console.log('[SERVER] Port:', PORT);
  console.log('[SERVER] PC:     http://localhost:' + PORT);
  console.log('[SERVER] iPhone: http://' + localIP + ':' + PORT);
  console.log('[SERVER] Platform:', process.platform);
  console.log('[SERVER] Chrome:', getChromePath() || 'auto');
  console.log('[SERVER] Modo: LOCAL (sin Supabase)');
});
