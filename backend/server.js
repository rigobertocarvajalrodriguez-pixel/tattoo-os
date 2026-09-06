// NOTA DE SEGURIDAD: se intentó quitar esto (afecta a TODAS las conexiones salientes del
// proceso, no solo la base de datos, lo cual es un riesgo real de man-in-the-middle) pero el
// pooler de Supabase/Render en este proyecto concreto no conecta sin él - la opción
// `ssl:{rejectUnauthorized:false}` puesta solo en la conexión de PostgreSQL (más abajo) no fue
// suficiente por sí sola y rompió la conexión a la base de datos en producción. Se mantiene
// hasta poder investigar con más cuidado una alternativa que no debilite todo el proceso
// (por ejemplo, apuntar al certificado CA correcto en vez de desactivar la verificación).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

// Notificaciones de seguimiento por email (ver más abajo "SEGUIMIENTO DE CURACIÓN POR EMAIL"):
// un único remitente de la plataforma para todos los estudios, con el nombre visible del
// tatuador/estudio como remitente y el email de contacto del estudio como "Responder a" - así
// ningún dueño de estudio tiene que configurar SMTP propio.
//
// Se envía vía la API HTTPS de SendGrid (no SMTP): se probó SMTP contra Gmail (puertos 465 y
// 587) desde Render y las conexiones salientes daban timeout siempre - es un bloqueo de red del
// hosting/anti-abuso de Gmail hacia IPs de datacenter, no un problema de puerto. La API HTTPS de
// SendGrid no tiene ese problema. Requiere SENDGRID_API_KEY (API key de SendGrid) y
// SENDGRID_FROM_EMAIL (el email verificado como "Single Sender" en SendGrid - tiene que
// coincidir exactamente con el verificado, si no SendGrid rechaza el envío). Sin esas dos vars
// en el entorno, los emails simplemente no se envían (se quedan en 'pending'); el resto de la
// app sigue funcionando igual, mismo criterio que la conexión a PostgreSQL más abajo.
var SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
var SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || '';
var mailEnabled = !!(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL);
if (mailEnabled) {
  console.log('[MAIL] SendGrid configurado, remitente verificado:', SENDGRID_FROM_EMAIL);
} else {
  console.warn('[MAIL] SENDGRID_API_KEY/SENDGRID_FROM_EMAIL no configurados - los emails de seguimiento quedarán pendientes hasta que se configuren.');
}

// Envía un email vía la API HTTPS de SendGrid. `fromName` es el nombre visible del remitente
// (tatuador/estudio, cambia por email) - el email del remitente siempre es SENDGRID_FROM_EMAIL
// (el único verificado en SendGrid), eso no puede variar por tatuador sin verificar cada email
// por separado en SendGrid, así que la identidad por tatuador se logra solo con el nombre.
function sendEmailViaSendGrid(opts) {
  var content = [{ type: 'text/plain', value: opts.text }];
  // SendGrid quiere el texto plano antes que el HTML en el array "content" (define el orden de
  // las partes MIME) - si no se manda html, el cliente de correo usa el texto plano tal cual.
  if (opts.html) content.push({ type: 'text/html', value: opts.html });
  var payload = {
    personalizations: [{ to: [{ email: opts.to }] }],
    from: { email: SENDGRID_FROM_EMAIL, name: opts.fromName || 'Tattoo OS' },
    subject: opts.subject,
    content: content,
  };
  if (opts.replyTo) payload.reply_to = { email: opts.replyTo };
  return fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SENDGRID_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }).then(function(r) {
    if (r.status >= 200 && r.status < 300) return true;
    return r.text().then(function(t) {
      throw new Error('SendGrid ' + r.status + ': ' + t);
    });
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Convierte el cuerpo en texto plano de una regla (líneas separadas por \n, algunas empiezan
// por "- " como viñeta) en HTML: cada línea suelta es un párrafo, las líneas de viñeta
// consecutivas se agrupan en una lista <ul>. Coincide con cómo el dueño del estudio escribe las
// reglas en Ajustes > Notificaciones por email (texto libre con guiones para listas).
function renderEmailBodyHtml(text) {
  var lines = String(text || '').split('\n');
  var html = '';
  var i = 0;
  var pStyle = 'margin:0 0 16px;font:400 15px/1.7 Arial,Helvetica,sans-serif;color:#c3c5d9;';
  var ulStyle = 'margin:0 0 16px;padding-left:20px;font:400 15px/1.7 Arial,Helvetica,sans-serif;color:#c3c5d9;';
  while (i < lines.length) {
    var line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (/^-\s+/.test(line.trim())) {
      var items = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        items.push('<li style="margin:0 0 6px;">' + escapeHtml(lines[i].trim().replace(/^-\s+/, '')) + '</li>');
        i++;
      }
      html += '<ul style="' + ulStyle + '">' + items.join('') + '</ul>';
    } else {
      html += '<p style="' + pStyle + '">' + escapeHtml(line) + '</p>';
      i++;
    }
  }
  return html;
}

// Plantilla visual de los correos de seguimiento (estética "TOS": fondo oscuro, insignia de
// marca, tipografía clara) - a pedido explícito del dueño sobre cómo quiere que se vean sus
// correos, a partir de un diseño de referencia (bienvenida-tattoos.png). El "heading" es el
// subject ya personalizado (trae el {nombre} del cliente resuelto), el cuerpo es el texto de la
// regla convertido a HTML con renderEmailBodyHtml.
// Cabecera y pie compartidos por todos los correos con la estética "TOS" (insignia de marca +
// etiqueta a la derecha; pie con dos columnas) - ver buildFollowupEmailHtml y
// buildWelcomeEmailHtml, que solo cambian el contenido central.
function emailHeaderHtml(label) {
  return '<tr><td style="padding-bottom:20px;border-bottom:1px solid #23263a;">' +
    '<table role="presentation" width="100%"><tr>' +
    '<td style="font:700 13px/1 Arial,Helvetica,sans-serif;letter-spacing:1px;color:#c9c6ff;background:#1c1f33;border:1px solid #34375a;border-radius:6px;padding:8px 12px;" width="1">TOS</td>' +
    '<td>&nbsp;</td>' +
    '<td align="right" style="font:600 11px/1 Arial,Helvetica,sans-serif;letter-spacing:1.5px;color:#787c99;white-space:nowrap;">' + escapeHtml(label) + '</td>' +
    '</tr></table></td></tr>';
}
function emailFooterHtml(left, right) {
  return '<tr><td style="padding-top:32px;">' +
    '<table role="presentation" width="100%" style="border-top:1px solid #23263a;"><tr>' +
    '<td style="padding-top:18px;font:400 11px/1.5 Arial,Helvetica,sans-serif;color:#5c5f78;">' + left + '</td>' +
    '<td align="right" style="padding-top:18px;font:400 11px/1.5 Arial,Helvetica,sans-serif;color:#5c5f78;white-space:nowrap;">' + right + '</td>' +
    '</tr></table></td></tr>';
}
function emailShellHtml(title, innerRowsHtml) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">' +
    '<title>' + escapeHtml(title) + '</title></head>' +
    '<body style="margin:0;padding:0;background:#0b0d14;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0d14;"><tr><td align="center" style="padding:40px 20px;">' +
    '<table role="presentation" width="100%" style="max-width:560px;" cellpadding="0" cellspacing="0">' +
    innerRowsHtml +
    '</table></td></tr></table>' +
    '</body></html>';
}

function buildFollowupEmailHtml(opts) {
  var bodyHtml = renderEmailBodyHtml(opts.bodyText);
  var signature = opts.senderName
    ? '<tr><td style="padding:8px 0 0;font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#9092ab;">&mdash; ' + escapeHtml(opts.senderName) + '</td></tr>'
    : '';
  var rows = emailHeaderHtml('SEGUIMIENTO') +
    '<tr><td style="padding:28px 0 12px;"><div style="font:700 25px/1.3 Arial,Helvetica,sans-serif;color:#f4f4f8;">' + escapeHtml(opts.heading) + '</div></td></tr>' +
    '<tr><td>' + bodyHtml + '</td></tr>' +
    signature +
    emailFooterHtml('Tattoo OS &middot; Seguimiento de curaci&oacute;n', 'Responde a este correo para escribirnos');
  return emailShellHtml(opts.heading, rows);
}

// Correo de bienvenida al registrarse (misma estética "TOS") - a partir de una referencia
// visual dada por el usuario (bienvenida-tattoos.png). El contenido está adaptado a lo que la
// app hace de verdad hoy: se quitó la sección de "Plan/Facturación" de la referencia (no hay
// prueba con límite de días ni cobro real todavía) y "soporte@tattoos.app" (dominio que no
// existe) se cambió por el contacto real - ver WELCOME_EMAIL_CONTACT.
var WELCOME_EMAIL_CONTACT = 'rigobertocarvajalrodriguez@gmail.com';
var WELCOME_FEATURES = [
  ['Agenda de citas', 'Reserva sesiones por tatuador, con duración, seña y estado. Ves el día del estudio completo y evitas huecos y solapamientos.'],
  ['Proyectos', 'Cada tatuaje es un proyecto: referencias, notas y las sesiones que lo componen, del primer boceto al último repaso.'],
  ['Clientes', 'Ficha con datos de contacto, consentimientos, historial de trabajos y notas privadas. Todo lo que necesitas antes de que se siente en la camilla.'],
  ['Finanzas', 'Ingresos por sesión, señas cobradas, gastos de material y reparto por tatuador. Sabes qué ha entrado esta semana sin abrir una hoja de cálculo.'],
  ['Avisos y curado', 'Recordatorios automáticos de la cita y, después, la pauta de cuidados del tatuaje enviada al cliente en los días que importan.'],
];
var WELCOME_STEPS = [
  'Completa el perfil de tu estudio: nombre y color de identificación.',
  'Añade a los tatuadores del equipo desde Ajustes → Equipo y roles. Si trabajas solo, con tu perfil es suficiente.',
  'Crea tu primer cliente, con su email para los avisos de cuidados post-tatuaje.',
  'Crea su proyecto y agenda la primera cita.',
  'Marca la cita como completada cuando termine la sesión, y comprueba que le llegan los correos de seguimiento.',
];
var WELCOME_ACCOUNT = [
  ['Acceso', 'El correo con el que te registraste.'],
  ['Equipo', 'Invita a tatuadores desde Ajustes → Equipo y roles.'],
];
var WELCOME_EMAIL_TEXT =
  'Bienvenido a Tattoo OS\n\n' +
  'Gracias por registrarte. Tattoo OS es el sistema de gestión para estudios de tatuajes y tatuadores: agenda, proyectos, clientes, finanzas y avisos, todo en un mismo panel.\n\n' +
  'QUÉ PUEDES HACER\n' + WELCOME_FEATURES.map(function(f) { return '- ' + f[0] + ': ' + f[1]; }).join('\n') + '\n\n' +
  'PRIMEROS PASOS\n' + WELCOME_STEPS.map(function(s, i) { return (i + 1) + '. ' + s; }).join('\n') + '\n\n' +
  'TU CUENTA\n' + WELCOME_ACCOUNT.map(function(a) { return a[0] + ': ' + a[1]; }).join('\n') + '\n\n' +
  'LOS DATOS DE TUS CLIENTES\n' +
  'La información de tus clientes es tuya: no se comparte con terceros ni se usa para publicidad. Solo las personas que invites a tu estudio pueden verla, y cada perfil tiene su nivel de acceso.\n' +
  'Puedes borrar los datos de un cliente en cualquier momento desde su ficha, y descargar una copia de seguridad completa de tu estudio desde Ajustes cuando quieras. Los consentimientos firmados quedan asociados a cada trabajo, con fecha.\n\n' +
  'CUANDO NECESITES AYUDA\n' +
  'Escríbenos a ' + WELCOME_EMAIL_CONTACT + ' y te contestamos en cuanto podamos. Si algo te bloquea, cuéntanoslo: en esta etapa cada mensaje cambia el producto.\n' +
  'Por ahora, lo mejor que puedes hacer es entrar y moverte por el panel con calma. Abre la agenda, crea un proyecto, mira las finanzas. Nada de lo que toques ahora rompe nada.';

function buildWelcomeEmailHtml() {
  var pStyle = 'margin:0 0 16px;font:400 15px/1.7 Arial,Helvetica,sans-serif;color:#c3c5d9;';
  var h2Style = 'margin:0 0 4px;font:700 18px/1.3 Arial,Helvetica,sans-serif;color:#f4f4f8;';

  var featureRows = WELCOME_FEATURES.map(function(f, i) {
    var border = i < WELCOME_FEATURES.length - 1 ? 'border-bottom:1px solid #1e2130;' : '';
    return '<tr><td style="padding:14px 0;' + border + '" valign="top">' +
      '<table role="presentation" width="100%"><tr>' +
      '<td width="140" valign="top" style="font:600 14px/1.5 Arial,Helvetica,sans-serif;color:#b7b2ff;padding-right:16px;">' + escapeHtml(f[0]) + '</td>' +
      '<td valign="top" style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#c3c5d9;">' + escapeHtml(f[1]) + '</td>' +
      '</tr></table></td></tr>';
  }).join('');

  var stepsHtml = '<ol style="margin:0 0 8px;padding-left:20px;font:400 15px/1.7 Arial,Helvetica,sans-serif;color:#c3c5d9;">' +
    WELCOME_STEPS.map(function(s) { return '<li style="margin:0 0 8px;">' + escapeHtml(s) + '</li>'; }).join('') +
    '</ol>';

  var accountRows = WELCOME_ACCOUNT.map(function(a, i) {
    var border = i < WELCOME_ACCOUNT.length - 1 ? 'border-bottom:1px solid #1e2130;' : '';
    return '<tr><td style="padding:12px 0;' + border + '" valign="top">' +
      '<table role="presentation" width="100%"><tr>' +
      '<td width="90" valign="top" style="font:600 11px/1.6 Arial,Helvetica,sans-serif;letter-spacing:.5px;color:#787c99;text-transform:uppercase;padding-right:16px;">' + escapeHtml(a[0]) + '</td>' +
      '<td valign="top" style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#c3c5d9;">' + escapeHtml(a[1]) + '</td>' +
      '</tr></table></td></tr>';
  }).join('');

  var mailto = '<a href="mailto:' + WELCOME_EMAIL_CONTACT + '" style="color:#b7b2ff;text-decoration:underline;">' + WELCOME_EMAIL_CONTACT + '</a>';

  var rows = emailHeaderHtml('BIENVENIDA') +
    '<tr><td style="padding:28px 0 12px;"><div style="font:700 26px/1.3 Arial,Helvetica,sans-serif;color:#f4f4f8;">Bienvenido a Tattoo OS</div></td></tr>' +
    '<tr><td><p style="' + pStyle + '">Gracias por registrarte. Tattoo OS es el sistema de gestión para estudios de tatuajes y tatuadores: agenda, proyectos, clientes, finanzas y avisos, todo en un mismo panel. Este correo te explica en dos minutos qué hay dentro y por dónde empezar.</p></td></tr>' +

    '<tr><td style="padding:20px 0 6px;"><div style="' + h2Style + '">Qué puedes hacer</div></td></tr>' +
    '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + featureRows + '</table></td></tr>' +

    '<tr><td style="padding:28px 0 6px;"><div style="' + h2Style + '">Primeros pasos</div></td></tr>' +
    '<tr><td><p style="' + pStyle + '">No hace falta hacerlo todo hoy. En este orden, el panel empieza a serte útil desde el primer día.</p></td></tr>' +
    '<tr><td>' + stepsHtml + '</td></tr>' +

    '<tr><td style="padding:28px 0 6px;"><div style="' + h2Style + '">Tu cuenta</div></td></tr>' +
    '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + accountRows + '</table></td></tr>' +

    '<tr><td style="padding:28px 0 6px;"><div style="' + h2Style + '">Los datos de tus clientes</div></td></tr>' +
    '<tr><td><p style="' + pStyle + '">La información de tus clientes es tuya: no se comparte con terceros ni se usa para publicidad. Solo las personas que invites a tu estudio pueden verla, y cada perfil tiene su nivel de acceso.</p></td></tr>' +
    '<tr><td><p style="' + pStyle + '">Puedes borrar los datos de un cliente en cualquier momento desde su ficha, y descargar una copia de seguridad completa de tu estudio desde Ajustes cuando quieras. Los consentimientos firmados quedan asociados a cada trabajo, con fecha.</p></td></tr>' +

    '<tr><td style="padding:24px 0 0;">' +
    '<table role="presentation" width="100%" style="background:#171a26;border:1px solid #262a3d;border-radius:12px;" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 22px;">' +
    '<div style="font:700 15px/1.4 Arial,Helvetica,sans-serif;color:#f4f4f8;margin:0 0 10px;">Cuando necesites ayuda</div>' +
    '<p style="margin:0 0 12px;font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#aeb0c4;">Escríbenos a ' + mailto + ' y te contestamos en cuanto podamos. Si algo te bloquea, cuéntanoslo: en esta etapa cada mensaje cambia el producto.</p>' +
    '<p style="margin:0;font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#aeb0c4;">Por ahora, lo mejor que puedes hacer es entrar y moverte por el panel con calma. Abre la agenda, crea un proyecto, mira las finanzas. Nada de lo que toques ahora rompe nada.</p>' +
    '</td></tr></table></td></tr>' +

    emailFooterHtml('Tattoo OS &middot; Correo de bienvenida', mailto);

  return emailShellHtml('Bienvenido a Tattoo OS', rows);
}

// Correo de recuperación de contraseña (misma estética "TOS") - el botón usa el color de acento
// como fondo relleno (en vez de solo texto con subrayado, como en los demás correos) porque es
// la única acción real que tiene este correo y conviene que destaque a simple vista.
function buildPasswordResetEmailHtml(resetUrl) {
  var pStyle = 'margin:0 0 16px;font:400 15px/1.7 Arial,Helvetica,sans-serif;color:#c3c5d9;';
  var button = '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#b7b2ff;">' +
    '<a href="' + escapeHtml(resetUrl) + '" style="display:inline-block;padding:12px 22px;font:700 14px/1 Arial,Helvetica,sans-serif;color:#0b0d14;text-decoration:none;border-radius:8px;">Restablecer contraseña</a>' +
    '</td></tr></table>';
  var rows = emailHeaderHtml('RECUPERAR ACCESO') +
    '<tr><td style="padding:28px 0 12px;"><div style="font:700 26px/1.3 Arial,Helvetica,sans-serif;color:#f4f4f8;">Recupera tu contraseña</div></td></tr>' +
    '<tr><td><p style="' + pStyle + '">Alguien (probablemente tú) pidió restablecer la contraseña de tu cuenta de Tattoo OS. Pulsa el botón para elegir una nueva.</p></td></tr>' +
    '<tr><td style="padding:4px 0 20px;">' + button + '</td></tr>' +
    '<tr><td><p style="' + pStyle + '">Este enlace caduca en 1 hora y solo funciona una vez. Si no fuiste tú, ignora este correo: tu contraseña actual sigue funcionando igual.</p></td></tr>' +
    emailFooterHtml('Tattoo OS &middot; Recuperar contraseña', 'Responde a este correo si algo falla');
  return emailShellHtml('Recupera tu contraseña', rows);
}

// Fase 1 de roles/planes: cuántos perfiles (dueño + artistas) caben en cada plan.
// estudio_pro es "ilimitado" -> Infinity nunca se alcanza en la comprobación de abajo.
var PLAN_PROFILE_LIMITS = { independiente: 1, estudio: 3, estudio_pro: Infinity };

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

// Roles y planes reales (Fase 1): hasta ahora ambos eran cosméticos (el plan vivía en
// localStorage del navegador, sin enforcement en el servidor). access_role es un nombre nuevo
// a propósito - profiles.role ya existe y es el puesto en texto libre ("Tatuador Principal"),
// no debe confundirse con el rol de permisos.
Promise.all([
  db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'independiente'"),
  db.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS access_role TEXT NOT NULL DEFAULT 'artist'"),
]).then(function() {
  return Promise.all([
    db.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check"),
    db.query("ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_access_role_check"),
  ]);
}).then(function() {
  return Promise.all([
    db.query("ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('independiente','estudio','estudio_pro'))"),
    db.query("ALTER TABLE profiles ADD CONSTRAINT profiles_access_role_check CHECK (access_role IN ('owner','artist'))"),
  ]);
}).then(function() {
  // Backfill 1: el perfil ya marcado is_admin_profile pasa a access_role='owner'.
  return db.query("UPDATE profiles SET access_role='owner' WHERE is_admin_profile=TRUE AND access_role<>'owner'");
}).then(function() {
  // Backfill 2: plan por cuenta según cuántos perfiles tiene ya, para no romper cuentas reales
  // que ya tuvieran más de 1-3 perfiles bajo el antiguo selector cosmético (0-1→independiente,
  // 2-3→estudio, 4+→estudio_pro). Solo toca cuentas que sigan en el valor por defecto, así que
  // no pisa un plan ya asignado a mano/por pago en el futuro.
  return db.query(
    "UPDATE users u SET plan = sub.suggested_plan " +
    "FROM (SELECT p.user_id, " +
    "  CASE WHEN COUNT(p.id) <= 1 THEN 'independiente' " +
    "       WHEN COUNT(p.id) <= 3 THEN 'estudio' " +
    "       ELSE 'estudio_pro' END AS suggested_plan " +
    "  FROM profiles p GROUP BY p.user_id) sub " +
    "WHERE u.id = sub.user_id AND u.plan = 'independiente'"
  );
}).then(function() {
  console.log('[DB] Migración de roles/planes (Fase 1) aplicada');
}).catch(function(e) { console.error('[DB] Error en migración de roles/planes:', e.message); });

// Panel de superadmin de la plataforma (distinto de access_role='owner' de la Fase 1 - ese es
// el dueño de UN estudio; is_admin/ADMIN_EMAIL es quien gestiona TODOS los estudios): activar/
// desactivar cuentas, última actividad y un log de auditoría simple de cada vez que el admin
// entra en "modo soporte" a ver la cuenta de un usuario.
Promise.all([
  db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE'),
  db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ'),
  db.query(`CREATE TABLE IF NOT EXISTS admin_access_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    admin_email TEXT NOT NULL,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_email  TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW())`),
]).then(function() {
  return db.query('CREATE INDEX IF NOT EXISTS idx_admin_access_log_user ON admin_access_log(user_id)');
}).then(function() {
  console.log('[DB] Migración de panel superadmin aplicada');
}).catch(function(e) { console.error('[DB] Error en migración de panel superadmin:', e.message); });

// Seguimiento de curación por EMAIL (sustituye al que era por WhatsApp - ver
// "SEGUIMIENTO DE CURACIÓN POR EMAIL" más abajo). notification_email es el email de contacto
// del estudio (Responder-a de las notificaciones) - se auto-vincula al email de la cuenta al
// registrarse y solo el dueño/superadmin pueden cambiarlo después. studio_name en profiles
// existía en el frontend (Ajustes > Estudio) pero nunca se guardaba en el servidor - hace
// falta aquí porque el remitente de cada email lo arma el propio backend (nombre del
// tatuador + su estudio), no el navegador.
Promise.all([
  db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email TEXT'),
  db.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS studio_name TEXT'),
  db.query(`CREATE TABLE IF NOT EXISTS email_rules (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    offset_days  INTEGER NOT NULL DEFAULT 1,
    offset_hour  INTEGER NOT NULL DEFAULT 11,
    subject      TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ DEFAULT NOW())`),
  db.query(`CREATE TABLE IF NOT EXISTS email_followups (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id TEXT NOT NULL,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id        UUID REFERENCES email_rules(id) ON DELETE SET NULL,
    client_name    TEXT NOT NULL,
    client_email   TEXT NOT NULL,
    sender_name    TEXT NOT NULL DEFAULT '',
    subject        TEXT NOT NULL DEFAULT '',
    body           TEXT NOT NULL DEFAULT '',
    scheduled_at   TIMESTAMPTZ NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    sent_at        TIMESTAMPTZ,
    error          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW())`),
]).then(function() {
  return Promise.all([
    db.query('UPDATE users SET notification_email=email WHERE notification_email IS NULL'),
    db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_followup_unique ON email_followups(appointment_id, rule_id)'),
    db.query('CREATE INDEX IF NOT EXISTS idx_email_rules_user ON email_rules(user_id)'),
    db.query('CREATE INDEX IF NOT EXISTS idx_email_followups_user ON email_followups(user_id)'),
  ]);
}).then(function() {
  console.log('[DB] Migración de seguimiento por email aplicada');
}).catch(function(e) { console.error('[DB] Error en migración de seguimiento por email:', e.message); });

// Recuperar contraseña por email: el frontend ya tenía un formulario "¿Olvidaste tu
// contraseña?" (pestaña "forgot" del login) pero era un stub visual que no llamaba a ningún
// sitio - ver sendForgot() en el frontend, ahora conectado de verdad. reset_token es de un solo
// uso: se borra en cuanto se usa, y pedir uno nuevo invalida cualquier anterior (solo el último
// enlace enviado funciona).
Promise.all([
  db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT'),
  db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ'),
]).then(function() {
  console.log('[DB] Migración de recuperación de contraseña aplicada');
}).catch(function(e) { console.error('[DB] Error en migración de recuperación de contraseña:', e.message); });

// Aislamiento real de datos por CUENTA a nivel de base de datos. Hasta ahora profiles.id y los
// ids de citas/clientes/gastos/proyectos/documentos/consentimientos/plantillas/mensajes de
// WhatsApp/ventas de mostrador los generaba el propio navegador (contadores 1,2,3... que
// arrancan de cero en cada cuenta) y la BD los usaba tal cual como clave única GLOBAL - dos
// cuentas distintas podían generar el mismo id y sus filas se pisaban entre sí sin ningún aviso
// (INSERT... ON CONFLICT (id) DO UPDATE). Esto no era teórico: se confirmó en la práctica un
// cliente y una cita de prueba sobrescribiendo datos reales de otra cuenta con el mismo id.
//
// Arreglo: las claves (primarias y foráneas) pasan de ser solo `id` a ser compuestas
// `(user_id, id)` - el id solo tiene que ser único DENTRO de la cuenta que lo generó, que es
// justo lo que ya garantiza reseedIdCounters() en el navegador. El navegador no cambia: sigue
// generando ids simples, pero ahora dos cuentas pueden usar el mismo número sin pisarse. Todas
// las consultas de la app que antes filtraban solo por profile_id/id ahora añaden también
// user_id (ver INSERT...ON CONFLICT y los SELECT/UPDATE/DELETE por :id de perfil más abajo).
//
// Idempotente: si profiles_pkey ya incluye user_id, no hace nada (para no re-ejecutar en cada
// arranque). Va al final de las migraciones porque necesita que todas las tablas ya existan.
function migrateToPerAccountKeys() {
  return db.query(
    "SELECT 1 FROM information_schema.key_column_usage " +
    "WHERE table_name='profiles' AND constraint_name='profiles_pkey' AND column_name='user_id'"
  ).then(function(r) {
    if (r.rows.length) return; // ya migrado
    console.log('[DB] Migrando claves a (user_id, id) por cuenta...');
    function run(sql) { return db.query(sql).catch(function(e) { console.error('[DB]   fallo en paso de migración de claves:', sql, '->', e.message); }); }
    function runSeq(list) { return list.reduce(function(p, sql) { return p.then(function() { return run(sql); }); }, Promise.resolve()); }

    return runSeq([
      // 1) Quitar las FK que apuntan a profiles(id) - hace falta antes de poder tocar su PK.
      'ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_profile_id_fkey',
      'ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_artist_id_fkey',
      'ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_profile_id_fkey',
      'ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_profile_id_fkey',
      'ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_profile_id_fkey',
      'ALTER TABLE doc_files DROP CONSTRAINT IF EXISTS doc_files_profile_id_fkey',
      'ALTER TABLE consents DROP CONSTRAINT IF EXISTS consents_profile_id_fkey',
      'ALTER TABLE doc_templates DROP CONSTRAINT IF EXISTS doc_templates_profile_id_fkey',
      'ALTER TABLE wa_messages DROP CONSTRAINT IF EXISTS wa_messages_profile_id_fkey',
      'ALTER TABLE commission_settlements DROP CONSTRAINT IF EXISTS commission_settlements_artist_id_fkey',
    ]).then(function() {
      // 2) profiles: de PRIMARY KEY (id) a (user_id, id).
      return runSeq([
        'ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_pkey',
        'ALTER TABLE profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id, id)',
      ]);
    }).then(function() {
      // 3) Recrear las FK como compuestas, apuntando a profiles(user_id, id).
      return runSeq([
        'ALTER TABLE appointments ADD CONSTRAINT appointments_profile_id_fkey FOREIGN KEY (user_id, profile_id) REFERENCES profiles(user_id, id) ON DELETE CASCADE',
        'ALTER TABLE appointments ADD CONSTRAINT appointments_artist_id_fkey FOREIGN KEY (user_id, artist_id) REFERENCES profiles(user_id, id)',
        'ALTER TABLE clients ADD CONSTRAINT clients_profile_id_fkey FOREIGN KEY (user_id, profile_id) REFERENCES profiles(user_id, id) ON DELETE CASCADE',
        'ALTER TABLE expenses ADD CONSTRAINT expenses_profile_id_fkey FOREIGN KEY (user_id, profile_id) REFERENCES profiles(user_id, id) ON DELETE CASCADE',
        'ALTER TABLE projects ADD CONSTRAINT projects_profile_id_fkey FOREIGN KEY (user_id, profile_id) REFERENCES profiles(user_id, id) ON DELETE CASCADE',
        'ALTER TABLE doc_files ADD CONSTRAINT doc_files_profile_id_fkey FOREIGN KEY (user_id, profile_id) REFERENCES profiles(user_id, id) ON DELETE CASCADE',
        'ALTER TABLE consents ADD CONSTRAINT consents_profile_id_fkey FOREIGN KEY (user_id, profile_id) REFERENCES profiles(user_id, id) ON DELETE CASCADE',
        'ALTER TABLE doc_templates ADD CONSTRAINT doc_templates_profile_id_fkey FOREIGN KEY (user_id, profile_id) REFERENCES profiles(user_id, id) ON DELETE CASCADE',
        'ALTER TABLE wa_messages ADD CONSTRAINT wa_messages_profile_id_fkey FOREIGN KEY (user_id, profile_id) REFERENCES profiles(user_id, id) ON DELETE CASCADE',
        'ALTER TABLE commission_settlements ADD CONSTRAINT commission_settlements_artist_id_fkey FOREIGN KEY (user_id, artist_id) REFERENCES profiles(user_id, id)',
      ]);
    }).then(function() {
      // 4) Las tablas con su propio id de cliente-generado: de PRIMARY KEY (id) a (user_id, id).
      return runSeq(['appointments', 'clients', 'expenses', 'projects', 'doc_files', 'consents', 'wa_messages', 'pos_sales'].reduce(function(acc, t) {
        return acc.concat([
          'ALTER TABLE ' + t + ' DROP CONSTRAINT IF EXISTS ' + t + '_pkey',
          'ALTER TABLE ' + t + ' ADD CONSTRAINT ' + t + '_pkey PRIMARY KEY (user_id, id)',
        ]);
      }, []));
    }).then(function() {
      // 5) doc_templates: su PK ya era compuesta (profile_id, template_id) - le falta user_id.
      return runSeq([
        'ALTER TABLE doc_templates DROP CONSTRAINT IF EXISTS doc_templates_pkey',
        'ALTER TABLE doc_templates ADD CONSTRAINT doc_templates_pkey PRIMARY KEY (user_id, profile_id, template_id)',
      ]);
    }).then(function() {
      console.log('[DB] Migración de claves por cuenta completada');
    });
  }).catch(function(e) { console.error('[DB] Error migrando a claves por cuenta:', e.message); });
}
migrateToPerAccountKeys();

const app = express();
app.set('trust proxy', 1);
// CORS abierto solo fuera de producción (desarrollo local / pruebas por LAN con el móvil, donde
// el frontend se sirve desde otro origen pero API_BASE sigue apuntando a Render). En producción
// los usuarios reales siempre acceden a la API desde el mismo origen (misma URL de Render), así
// que restringir aquí no les afecta y sí bloquea a cualquier otra web que intente llamar a la API.
const PROD_ORIGIN = 'https://tattoo-os-pdbp.onrender.com';
app.use(cors(process.env.NODE_ENV === 'production' ? { origin: PROD_ORIGIN } : {}));
// Cabeceras de seguridad básicas. Deliberadamente sin Content-Security-Policy todavía: el
// frontend es un único HTML con mucho <script>/<style> inline y onclick="", una CSP por defecto
// lo rompería - queda pendiente para cuando se audite ese código con más calma.
app.use(function(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
app.use(express.json());
// Modo soporte (ver PANEL SUPERADMIN más abajo): un token de sesión creado por
// POST /api/admin/impersonate lleva readOnly:true. Se bloquea aquí, a nivel global, cualquier
// método que no sea de lectura - así ninguna ruta existente ni futura tiene que acordarse de
// comprobarlo caso por caso. Única excepción: cerrar la propia sesión de soporte (logout).
var READ_ONLY_SAFE_METHODS = { GET: true, HEAD: true, OPTIONS: true };
var READ_ONLY_ALLOWED_PATHS = ['/api/auth/logout'];
app.use(function(req, res, next) {
  if (READ_ONLY_SAFE_METHODS[req.method] || READ_ONLY_ALLOWED_PATHS.indexOf(req.path) !== -1) return next();
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  var session = token && authSessions[token];
  if (session && session.readOnly) {
    return res.status(403).json({ error: 'Modo soporte: solo lectura. Los cambios no se guardan en la cuenta de este usuario.' });
  }
  next();
});
// index:false — ya no queremos que express.static sirva frontend/app.html automáticamente en
// "/" (comportamiento por defecto de static con un archivo index.html). La landing pública y la
// app autenticada ahora son documentos distintos, servidos explícitamente más abajo.
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: false }));

// ── LANDING PÚBLICA vs APP ──
// "/" es la landing pública (marketing, sin login). "/app" es el dashboard real (login/registro +
// app), que sigue decidiendo por sí mismo -vía el token en localStorage- si mostrar la pantalla de
// login o el panel. La landing detecta ese mismo token en el navegador y redirige a /app antes de
// pintar nada si el usuario ya tiene sesión, así que un usuario logueado nunca ve la landing.
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'landing.html'));
});
app.get('/app', function(req, res) {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'app.html'));
});
// Alias amigables usados por los CTA de la landing — igual que hoy, la pantalla real de
// login/registro vive dentro de app.html (pestañas), esto solo abre en la pestaña correcta.
app.get('/login', function(req, res) { res.redirect('/app'); });
app.get('/register', function(req, res) { res.redirect('/app?auth=register'); });

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
bcrypt.hash(ADMIN_PASS, 10).then(function(adminHash) {
  return db.query(
    'INSERT INTO users (email, name, password, is_admin) VALUES ($1,$2,$3,TRUE) ON CONFLICT (email) DO NOTHING',
    [ADMIN_EMAIL, 'Admin', adminHash]
  );
}).then(function() {
  console.log('[AUTH] Admin verificado en BD:', ADMIN_EMAIL);
}).catch(function(e) {
  // Fallback: also keep JSON so app still works if DB is down
  var users = readJSON('users.json');
  if (!users.find(function(u) { return u.email === ADMIN_EMAIL; })) {
    users.push({ id: crypto.randomUUID(), email: ADMIN_EMAIL, name: 'Admin', password: ADMIN_PASS, isAdmin: true, created_at: new Date().toISOString() });
    writeJSON('users.json', users);
  }
});

var BCRYPT_RE = /^\$2[aby]\$/;

// Auth sessions in memory: token → { userId, email, name, isAdmin }
const authSessions = {};

// Límite de intentos simple en memoria (sin Redis en este proyecto, pero con una sola instancia
// Render es suficiente) para frenar fuerza bruta contra login/registro por IP.
var loginAttempts = {};
var RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
var RATE_LIMIT_MAX = 10;
function loginRateLimiter(req, res, next) {
  var ip = req.ip || 'unknown';
  var now = Date.now();
  var attempts = (loginAttempts[ip] || []).filter(function(t) { return now - t < RATE_LIMIT_WINDOW_MS; });
  if (attempts.length >= RATE_LIMIT_MAX) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  attempts.push(now);
  loginAttempts[ip] = attempts;
  next();
}
setInterval(function() {
  var now = Date.now();
  Object.keys(loginAttempts).forEach(function(ip) {
    loginAttempts[ip] = loginAttempts[ip].filter(function(t) { return now - t < RATE_LIMIT_WINDOW_MS; });
    if (!loginAttempts[ip].length) delete loginAttempts[ip];
  });
}, RATE_LIMIT_WINDOW_MS);

// ── AUTH ENDPOINTS ──
app.post('/api/auth/login', loginRateLimiter, function(req, res) {
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
        if (user.active === false) return res.status(403).json({ error: 'Esta cuenta ha sido desactivada. Contacta con soporte.' });
        var token = crypto.randomUUID();
        authSessions[token] = { userId: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin };
        db.query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id]).catch(function() {});
        res.json({ token: token, user: { id: user.id, email: user.email, name: user.name } });
      });
    })
    .catch(function(e) { res.status(500).json({ error: 'Error de base de datos' }); });
});

app.post('/api/auth/register', loginRateLimiter, function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var pass = req.body.password || '';
  var name = (req.body.name || email.split('@')[0]).trim();
  if (!email || !pass) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (pass.length < 8) return res.status(400).json({ error: 'Contraseña mínimo 8 caracteres' });
  bcrypt.hash(pass, 10).then(function(hash) {
    // notification_email arranca igual al email de la cuenta (auto-vinculado al registrarse,
    // ver migración "seguimiento por email" más arriba) - el dueño puede cambiarlo después.
    return db.query('INSERT INTO users (email, name, password, notification_email) VALUES ($1,$2,$3,$1) RETURNING *', [email, name, hash])
      .then(function(r) {
        var user = r.rows[0];
        var token = crypto.randomUUID();
        authSessions[token] = { userId: user.id, email: user.email, name: user.name, isAdmin: false };
        res.json({ token: token, user: { id: user.id, email: user.email, name: user.name } });
        // Correo de bienvenida: no bloquea la respuesta del registro ni la rompe si falla (por
        // eso va después de responder, con su propio catch) - es solo informativo, no forma
        // parte del flujo de autenticación.
        if (mailEnabled) {
          sendEmailViaSendGrid({
            fromName: 'Tattoo OS',
            replyTo: WELCOME_EMAIL_CONTACT,
            to: user.email,
            subject: 'Bienvenido a Tattoo OS',
            text: WELCOME_EMAIL_TEXT,
            html: buildWelcomeEmailHtml(),
          }).catch(function() {});
        }
      });
  }).catch(function(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'El email ya está registrado' });
    res.status(500).json({ error: 'Error de base de datos' });
  });
});

// Recuperar contraseña: respuesta siempre idéntica exista o no la cuenta (no revelar qué
// emails están registrados) - ver checkResetTokenFromUrl()/sendForgot() en el frontend, que ya
// tenía el formulario montado pero no llamaba a ningún endpoint real.
app.post('/api/auth/forgot-password', loginRateLimiter, function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var respondGeneric = function() { res.json({ ok: true }); };
  if (!email) return respondGeneric();
  db.query('SELECT id FROM users WHERE email=$1', [email]).then(function(r) {
    if (!r.rows.length) return; // cuenta inexistente: no se envía nada, pero la respuesta es igual
    var userId = r.rows[0].id;
    var token = crypto.randomUUID();
    var expires = new Date(Date.now() + 60 * 60 * 1000); // 1h
    return db.query('UPDATE users SET reset_token=$1, reset_token_expires=$2 WHERE id=$3', [token, expires, userId])
      .then(function() {
        if (!mailEnabled) return;
        var resetUrl = PROD_ORIGIN + '/app?resetToken=' + token;
        return sendEmailViaSendGrid({
          fromName: 'Tattoo OS',
          replyTo: WELCOME_EMAIL_CONTACT,
          to: email,
          subject: 'Recupera tu contraseña de Tattoo OS',
          text: 'Para restablecer tu contraseña entra a este enlace (caduca en 1 hora): ' + resetUrl,
          html: buildPasswordResetEmailHtml(resetUrl),
        }).catch(function() {});
      });
  }).catch(function() {}).then(respondGeneric);
});

app.post('/api/auth/reset-password', loginRateLimiter, function(req, res) {
  var token = (req.body.token || '').trim();
  var newPassword = req.body.newPassword || '';
  if (!token) return res.status(400).json({ error: 'Enlace inválido' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  db.query('SELECT id FROM users WHERE reset_token=$1 AND reset_token_expires > NOW()', [token]).then(function(r) {
    if (!r.rows.length) return res.status(400).json({ error: 'El enlace no es válido o ha caducado. Pide uno nuevo.' });
    var userId = r.rows[0].id;
    return bcrypt.hash(newPassword, 10).then(function(hash) {
      return db.query('UPDATE users SET password=$1, reset_token=NULL, reset_token_expires=NULL WHERE id=$2', [hash, userId]);
    }).then(function() { res.json({ ok: true }); });
  }).catch(function(e) { res.status(500).json({ error: 'Error de base de datos' }); });
});

app.get('/api/auth/me', function(req, res) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  var session = authSessions[token];
  if (!session) return res.status(401).json({ error: 'Token inválido' });
  // Plan real (Fase 1): se lee de BD en cada llamada, nunca del token en memoria, para que un
  // cambio de plan se refleje sin tener que volver a hacer login.
  db.query('SELECT plan FROM users WHERE id=$1', [session.userId])
    .then(function(r) {
      var plan = (r.rows[0] && r.rows[0].plan) || 'independiente';
      res.json({ user: { id: session.userId, email: session.email, name: session.name, plan: plan } });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Cambio de plan (Fase 1: sin cobro real todavía, igual que el selector cosmético anterior,
// pero ahora el valor queda en BD y de verdad limita cuántos perfiles caben - ver /api/profile/sync).
app.post('/api/user/plan', authMiddleware, function(req, res) {
  var plan = req.body.plan;
  if (['independiente', 'estudio', 'estudio_pro'].indexOf(plan) === -1) {
    return res.status(400).json({ error: 'Plan inválido' });
  }
  db.query('SELECT COUNT(*) FROM profiles WHERE user_id=$1', [req.userId])
    .then(function(r) {
      var current = parseInt(r.rows[0].count, 10);
      var limit = PLAN_PROFILE_LIMITS[plan];
      if (current > limit) {
        return res.status(403).json({ error: 'Tu cuenta ya tiene ' + current + ' perfiles; el plan "' + plan + '" permite máximo ' + limit + '. Elimina perfiles antes de bajar de plan.' });
      }
      return db.query('UPDATE users SET plan=$1 WHERE id=$2', [plan, req.userId]).then(function() {
        res.json({ ok: true, plan: plan });
      });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
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
      // --disable-web-security e --ignore-certificate-errors se quitan a propósito: apagaban la
      // política de mismo origen y la verificación de certificados TLS para todo lo que cargue
      // este Chrome (web.whatsapp.com usa certificados públicos normales, no hay razón real para
      // desactivar la verificación aquí, a diferencia del pooler de la base de datos).
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions'
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
  db.query(
    'SELECT u.id, u.email, u.name, u.is_admin, u.plan, u.active, u.created_at, u.last_login_at, ' +
    "COALESCE(pc.cnt, 0)::int AS profile_count " +
    'FROM users u LEFT JOIN (SELECT user_id, COUNT(*) AS cnt FROM profiles GROUP BY user_id) pc ON pc.user_id = u.id ' +
    'ORDER BY u.created_at ASC'
  )
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Cambiar el plan y/o activar/desactivar una cuenta a mano (upgrades de cortesía, corregir un
// error de pago, suspender una cuenta problemática...). No se puede tocar la cuenta del propio
// admin - evita que se bloquee a sí mismo sin querer. Reutiliza el mismo tope de perfiles por
// plan que /api/user/plan (self-service) para no dejar una cuenta con más perfiles de los que
// su plan permite.
app.patch('/api/admin/users/:id', adminMiddleware, function(req, res) {
  var targetId = req.params.id;
  db.query('SELECT id, is_admin FROM users WHERE id=$1', [targetId]).then(function(r) {
    if (!r.rows.length) { res.status(404).json({ error: 'Usuario no encontrado' }); return null; }
    if (r.rows[0].is_admin) { res.status(400).json({ error: 'No puedes modificar la cuenta de administrador' }); return null; }

    var chain = Promise.resolve();
    if (req.body.plan !== undefined) {
      var plan = req.body.plan;
      if (['independiente', 'estudio', 'estudio_pro'].indexOf(plan) === -1) {
        res.status(400).json({ error: 'Plan inválido' });
        return null;
      }
      chain = chain.then(function() {
        return db.query('SELECT COUNT(*) FROM profiles WHERE user_id=$1', [targetId]).then(function(cr) {
          var current = parseInt(cr.rows[0].count, 10);
          var limit = PLAN_PROFILE_LIMITS[plan];
          if (current > limit) {
            var err = new Error('Esta cuenta ya tiene ' + current + ' perfiles; el plan "' + plan + '" permite máximo ' + limit + '.');
            err.code = 'PLAN_LIMIT';
            throw err;
          }
          return db.query('UPDATE users SET plan=$1 WHERE id=$2', [plan, targetId]);
        });
      });
    }
    if (req.body.active !== undefined) {
      chain = chain.then(function() {
        return db.query('UPDATE users SET active=$1 WHERE id=$2', [!!req.body.active, targetId]);
      });
    }
    return chain.then(function() {
      return db.query(
        'SELECT id, email, name, is_admin, plan, active, created_at, last_login_at FROM users WHERE id=$1',
        [targetId]
      );
    }).then(function(ur) { res.json(ur.rows[0]); });
  }).catch(function(e) {
    if (e && e.code === 'PLAN_LIMIT') { res.status(403).json({ error: e.message }); return; }
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
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
  db.query('SELECT user_id FROM tickets WHERE id=$1', [req.params.id])
    .then(function(t) {
      if (!t.rows.length) { res.status(404).json({ error: 'Ticket no encontrado' }); return null; }
      var isAdm = req.user.isAdmin || req.user.email === ADMIN_EMAIL;
      if (!isAdm && t.rows[0].user_id !== req.userId) { res.status(403).json({ error: 'No autorizado' }); return null; }
      return db.query('SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC', [req.params.id]);
    })
    .then(function(r) { if (r) res.json(r.rows); })
    .catch(function(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); });
});

// El emisor ("admin" o "user") se decide con la sesión autenticada del servidor, nunca con
// req.body.sender - antes cualquier usuario podía mandar sender:"admin" y suplantar al soporte.
app.post('/api/tickets/:id/messages', authMiddleware, function(req, res) {
  db.query('SELECT user_id FROM tickets WHERE id=$1', [req.params.id])
    .then(function(t) {
      if (!t.rows.length) { res.status(404).json({ error: 'Ticket no encontrado' }); return null; }
      var isAdm = req.user.isAdmin || req.user.email === ADMIN_EMAIL;
      if (!isAdm && t.rows[0].user_id !== req.userId) { res.status(403).json({ error: 'No autorizado' }); return null; }
      var sender = isAdm ? 'admin' : 'user';
      var senderName = isAdm ? 'Admin' : (req.user.name || '');
      return db.query('INSERT INTO ticket_messages (ticket_id,sender,sender_name,message) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.params.id, sender, senderName, req.body.message])
        .then(function(r) {
          var newStatus = isAdm ? 'in_progress' : 'open';
          db.query('UPDATE tickets SET status=$1, updated_at=NOW(), has_unread=$2 WHERE id=$3',
            [newStatus, !isAdm, req.params.id]).catch(function(){});
          res.json(r.rows[0]);
        });
    })
    .catch(function(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); });
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
    [req.userId, req.user.email, req.user.name, req.body.title, req.body.description, req.body.priority||'normal'])
    .then(function(r) { res.json(r.rows[0]); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// ══════════════════════════════════════════
// SEGUIMIENTO DE CURACIÓN POR EMAIL (día 1 / día 3 tras completar la cita)
// ══════════════════════════════════════════
// Antes se enviaba por WhatsApp (wa_followups, ya no se usa - se deja la tabla en la BD por
// si hay algo pendiente de consultar, pero nada vuelve a escribir ni leer de ahí). Cada regla
// es ahora una fila real y editable por el dueño del estudio en email_rules (antes eran 2
// automatizaciones fijas dentro de waSettings) - se siembran 2 por defecto (día 1/día 3) la
// primera vez que una cuenta las necesita, para no perder el comportamiento de antes.
var DEFAULT_EMAIL_RULES = [
  { name: 'Seguimiento día 1', offset_days: 1, offset_hour: 11,
    subject: '¿Qué tal fue tu sesión, {nombre}?',
    body: 'Hola {nombre}! ¿Qué tal fue todo en la sesión de tu "{tattoo}"?\n\nTe dejo los cuidados para la curación:\n- Lava la zona con agua y jabón neutro 2 veces al día\n- Aplica una crema cicatrizante fina, sin tapar en exceso\n- No rasques ni arranques las pieles que se levanten\n- Evita el sol directo, la piscina, el mar y la sauna las próximas 2-3 semanas\n- Usa ropa holgada que no roce la zona\n\n¡Cualquier duda me escribes!' },
  { name: 'Seguimiento día 3', offset_days: 3, offset_hour: 11,
    subject: '¿Cómo va la curación de tu tatuaje?',
    body: 'Hola {nombre}! ¿Cómo va la curación de tu "{tattoo}"?\n\nSi puedes, mándame una foto para ver cómo va el proceso y así confirmamos que todo evoluciona bien.\n\n¡Gracias!' },
];

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

// El offset de cada regla (offset_days/offset_hour) se cuenta desde el momento en que se
// confirma/completa la cita (HOY, cuando corre esta función), no desde la fecha guardada en la
// cita - a petición explícita del dueño. dateStr es la fecha de HOY en formato YYYY-MM-DD (ver
// scheduleAftercareEmailsForClient), no la fecha de la cita.
function followupDate(dateStr, daysAhead, hour) {
  var d = new Date(dateStr + 'T' + (hour || 11) + ':00:00');
  if (isNaN(d.getTime())) d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d;
}

// Primera vez que una cuenta necesita sus reglas de email y no tiene ninguna: siembra las 2 de
// siempre (día 1/día 3) como filas reales y editables, en vez de una lista fija en código -
// así el dueño del estudio puede tocarlas o añadir más desde Ajustes sin perder las que ya
// tenía funcionando.
function ensureDefaultEmailRules(userId) {
  return db.query('SELECT COUNT(*) FROM email_rules WHERE user_id=$1', [userId]).then(function(r) {
    if (parseInt(r.rows[0].count, 10) > 0) return;
    return Promise.all(DEFAULT_EMAIL_RULES.map(function(rule) {
      return db.query(
        'INSERT INTO email_rules (user_id,name,offset_days,offset_hour,subject,body) VALUES ($1,$2,$3,$4,$5,$6)',
        [userId, rule.name, rule.offset_days, rule.offset_hour, rule.subject, rule.body]
      );
    }));
  });
}

// Called when an appointment transitions to status='completed': programa un email por cada
// regla activa del estudio. El remitente (nombre visible) es el del ARTISTA asignado a la
// cita (a.artistId) y, si tiene, el nombre de su estudio - no el de quien creó la cita, que
// puede ser el dueño gestionando la agenda de todos.
//
// El cliente se busca en la tabla (por user_id, toda la cuenta), no en profile.clients: el
// dueño del estudio ve/crea clientes y citas fusionados de todos los artistas en el navegador
// (rebuildMergedStore), pero cada uno sigue viviendo en el array del perfil donde se creó -
// una cita y su cliente pueden estar en profile_id distintos aunque en el navegador aparezcan
// juntos. Buscar solo en profile.clients (el perfil de LA CITA) los deja sin encontrarse.
// profilesData: el payload COMPLETO de este mismo /api/profile/sync (todos los perfiles, no
// solo el de la cita) - hace falta como respaldo porque los inserts de clientes y de citas de
// un mismo envío corren en paralelo (Promise.all), así que si un cliente es nuevo en el MISMO
// sync que completa su cita, su INSERT puede no haberse confirmado aún cuando esta consulta
// se ejecuta. Si la tabla todavía no lo tiene, se busca en el propio payload que se acaba de
// recibir (que sí lo tiene, es el origen de ese INSERT).
function scheduleAftercareEmails(userId, apptId, a, profile, profilesData) {
  return db.query(
    "SELECT email FROM clients WHERE user_id=$1 AND name=$2 AND email<>'' ORDER BY created_at DESC LIMIT 1",
    [userId, a.name || '']
  ).then(function(cr) {
    var email = cr.rows.length ? String(cr.rows[0].email).trim() : '';
    if (!email) email = findClientEmailInPayload(profilesData, a.name);
    if (!email) return;
    return scheduleAftercareEmailsForClient(userId, apptId, a, profile, email);
  }).catch(function() {});
}
function findClientEmailInPayload(profilesData, name) {
  if (!profilesData || !name) return '';
  for (var i = 0; i < profilesData.length; i++) {
    var clients = profilesData[i].clients || [];
    for (var j = 0; j < clients.length; j++) {
      if (clients[j].name === name && clients[j].email) return String(clients[j].email).trim();
    }
  }
  return '';
}
function scheduleAftercareEmailsForClient(userId, apptId, a, profile, email) {
  var vars = {
    nombre: followupFirstName(a.name),
    tattoo: a.workType || a.type || a.notes || a.note || 'tatuaje',
    fecha: a.date || '',
    precio: a.price || 0,
    senal: a.deposit || 0
  };

  return db.query('SELECT name, studio_name FROM profiles WHERE id=$1 AND user_id=$2', [a.artistId || profile.id, userId])
    .then(function(pr) {
      var artist = pr.rows[0];
      var senderName = artist ? (artist.studio_name ? artist.name + ' · ' + artist.studio_name : artist.name) : (profile.name || 'Tu tatuador/a');
      // Ancla del offset de cada regla: el momento en que se confirma/completa la cita (HOY),
      // no la fecha guardada en la cita - a petición explícita del dueño, para que "día 1"
      // signifique de verdad "1 día después de marcar esto", sin importar si a.date está
      // desactualizada o si la cita se confirma días después de la fecha que tenía puesta.
      var confirmedTodayStr = new Date().toISOString().slice(0, 10);
      return ensureDefaultEmailRules(userId).then(function() {
        return db.query('SELECT * FROM email_rules WHERE user_id=$1 AND enabled=TRUE', [userId]);
      }).then(function(r) {
        var jobs = r.rows.map(function(rule) {
          var subject = renderFollowupTemplate(rule.subject, vars);
          var body = renderFollowupTemplate(rule.body, vars);
          return db.query(
            'INSERT INTO email_followups (appointment_id,user_id,rule_id,client_name,client_email,sender_name,subject,body,scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (appointment_id,rule_id) DO NOTHING',
            [apptId, userId, rule.id, a.name || '', email, senderName, subject, body, followupDate(confirmedTodayStr, rule.offset_days, rule.offset_hour)]
          );
        });
        return Promise.all(jobs);
      });
    })
    .catch(function() {});
}

// Background worker: envía los emails de seguimiento programados que ya tocan.
setInterval(function() {
  if (!mailEnabled) return; // SENDGRID_API_KEY/SENDGRID_FROM_EMAIL sin configurar - ver arranque del servidor
  db.query("SELECT ef.*, u.notification_email FROM email_followups ef JOIN users u ON u.id=ef.user_id WHERE ef.status='pending' AND ef.scheduled_at <= NOW() ORDER BY ef.scheduled_at ASC LIMIT 20")
    .then(function(r) {
      r.rows.forEach(function(f) {
        sendEmailViaSendGrid({
          fromName: f.sender_name,
          replyTo: f.notification_email || undefined,
          to: f.client_email,
          subject: f.subject,
          text: f.body,
          html: buildFollowupEmailHtml({ heading: f.subject, bodyText: f.body, senderName: f.sender_name }),
        }).then(function() {
          return db.query("UPDATE email_followups SET status='sent', sent_at=NOW() WHERE id=$1", [f.id]);
        }).catch(function(e) {
          db.query("UPDATE email_followups SET status='failed', error=$1 WHERE id=$2", [e.message, f.id]).catch(function() {});
        });
      });
    })
    .catch(function() {});
}, 5 * 60 * 1000);

// Consulta de seguimientos programados/enviados (para mostrar en Ajustes > Notificaciones por email)
app.get('/api/email/followups', authMiddleware, function(req, res) {
  db.query('SELECT id,client_name,client_email,subject,status,scheduled_at,sent_at,error FROM email_followups WHERE user_id=$1 ORDER BY scheduled_at DESC LIMIT 100', [req.userId])
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Reglas de notificación por email: solo el dueño del estudio (o el superadmin de la
// plataforma, vía adminMiddleware en otra ruta si hiciera falta) puede crearlas/tocarlas -
// mismo criterio que el resto de Ajustes del estudio (ver SETTINGS_ADMIN_ONLY en el frontend).
function requireOwner(req, res) {
  if (req.user.accessRole === 'artist') { res.status(403).json({ error: 'Solo el dueño del estudio puede gestionar las notificaciones por email' }); return false; }
  return true;
}
app.get('/api/email-rules', authMiddleware, function(req, res) {
  ensureDefaultEmailRules(req.userId).then(function() {
    return db.query('SELECT * FROM email_rules WHERE user_id=$1 ORDER BY created_at ASC', [req.userId]);
  }).then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});
app.post('/api/email-rules', authMiddleware, function(req, res) {
  if (!requireOwner(req, res)) return;
  var b = req.body;
  if (!b.name || !b.subject || !b.body) return res.status(400).json({ error: 'Faltan campos (nombre, asunto, cuerpo)' });
  db.query(
    'INSERT INTO email_rules (user_id,name,offset_days,offset_hour,subject,body,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.userId, b.name, parseInt(b.offset_days, 10) || 0, parseInt(b.offset_hour, 10) || 11, b.subject, b.body, b.enabled !== false]
  ).then(function(r) { res.json(r.rows[0]); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});
app.patch('/api/email-rules/:id', authMiddleware, function(req, res) {
  if (!requireOwner(req, res)) return;
  var b = req.body;
  db.query(
    'UPDATE email_rules SET name=COALESCE($1,name),offset_days=COALESCE($2,offset_days),offset_hour=COALESCE($3,offset_hour),subject=COALESCE($4,subject),body=COALESCE($5,body),enabled=COALESCE($6,enabled) WHERE id=$7 AND user_id=$8 RETURNING *',
    [b.name, b.offset_days, b.offset_hour, b.subject, b.body, b.enabled, req.params.id, req.userId]
  ).then(function(r) { r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'No encontrada' }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});
app.delete('/api/email-rules/:id', authMiddleware, function(req, res) {
  if (!requireOwner(req, res)) return;
  db.query('DELETE FROM email_rules WHERE id=$1 AND user_id=$2', [req.params.id, req.userId])
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Email de contacto del estudio (Responder-a de las notificaciones, ver más arriba) - se
// auto-vincula al registrarse (backfill/registro más abajo) y solo el dueño o el superadmin
// pueden cambiarlo después.
app.get('/api/user/notification-email', authMiddleware, function(req, res) {
  db.query('SELECT notification_email FROM users WHERE id=$1', [req.userId])
    .then(function(r) { res.json({ notificationEmail: r.rows[0] && r.rows[0].notification_email }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});
app.patch('/api/user/notification-email', authMiddleware, function(req, res) {
  if (!requireOwner(req, res)) return;
  var email = (req.body.notificationEmail || '').trim();
  if (!email || email.indexOf('@') === -1) return res.status(400).json({ error: 'Email inválido' });
  db.query('UPDATE users SET notification_email=$1 WHERE id=$2', [email, req.userId])
    .then(function() { res.json({ ok: true, notificationEmail: email }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Profile sync: save full profile data to PostgreSQL
app.post('/api/profile/sync', authMiddleware, function(req, res) {
  var userId = req.userId;
  var profilesData = req.body.profiles;
  var posSalesData = req.body.posSales || [];
  if (!profilesData || !profilesData.length) return res.json({ ok: true });

  // Fase 1 - roles reales: un perfil "artist" solo puede sincronizar sus propios datos. El
  // frontend ya se autolimita (saveUserProfiles solo manda su propio perfil cuando el activo
  // no es owner), pero eso es convención de cliente, no seguridad real - el servidor filtra
  // aquí de nuevo por si el payload trajera algo más.
  if (req.user.accessRole === 'artist' && req.user.profileId != null) {
    profilesData = profilesData.filter(function(p) { return p.id === req.user.profileId; });
    if (!profilesData.length) return res.json({ ok: true });
  }

  // El perfil Administrador es el primero que existió para esta cuenta (id más bajo ya
  // guardado en la BD); si es la primerísima sincronización, es el id más bajo de este envío.
  db.query('SELECT plan FROM users WHERE id=$1', [userId]).then(function(userRow) {
    var plan = (userRow.rows[0] && userRow.rows[0].plan) || 'independiente';
    return db.query('SELECT id FROM profiles WHERE user_id=$1 ORDER BY id ASC', [userId]).then(function(existing) {
    var existingIds = existing.rows.map(function(r) { return r.id; });
    var adminId = existingIds.length
      ? existingIds[0]
      : Math.min.apply(null, profilesData.map(function(p) { return p.id; }));

    // Fase 1 - límite de perfiles por plan: solo bloquea profile_id NUEVOS (altas), nunca
    // actualizaciones de perfiles que ya existían - así nadie se queda sin poder guardar su
    // agenda de un día para otro por haber bajado de plan.
    var newIds = profilesData.map(function(p) { return p.id; }).filter(function(id) { return existingIds.indexOf(id) === -1; });
    if (newIds.length) {
      var limit = PLAN_PROFILE_LIMITS[plan] != null ? PLAN_PROFILE_LIMITS[plan] : PLAN_PROFILE_LIMITS.independiente;
      if (existingIds.length + newIds.length > limit) {
        var limitErr = new Error('Límite de perfiles alcanzado para el plan "' + plan + '" (máximo ' + limit + '). Actualiza de plan para añadir más artistas.');
        limitErr.code = 'PLAN_LIMIT';
        throw limitErr;
      }
    }

    var ops = profilesData.map(function(p) {
      return db.query(
        'INSERT INTO profiles (id,user_id,name,role,color,commission_pct,is_admin_profile,wa_settings,studio_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, id) DO UPDATE SET name=$3,role=$4,color=$5,commission_pct=$6,is_admin_profile=$7,wa_settings=$8,studio_name=$9',
        [p.id, userId, p.name||'', p.role||'', p.color||'v', typeof p.commissionPct==='number'?p.commissionPct:50, p.id === adminId, p.waSettings ? JSON.stringify(p.waSettings) : null, p.studioName||'']
      ).then(function() {
        var apptOps = (p.appts||[]).map(function(a) {
          var apptId = a.id !== undefined && a.id !== null ? String(a.id) : crypto.randomUUID();
          return db.query('SELECT status FROM appointments WHERE id=$1 AND user_id=$2', [apptId, userId]).then(function(prev) {
            var oldStatus = prev.rows.length ? prev.rows[0].status : null;
            return db.query(
              'INSERT INTO appointments (id,profile_id,user_id,name,date,start,dur,color,status,price,deposit,work_type,notes,artist_id,deposit_method,balance_method,balance_paid,balance_paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (user_id, id) DO UPDATE SET name=$4,date=$5,start=$6,dur=$7,color=$8,status=$9,price=$10,deposit=$11,work_type=$12,notes=$13,artist_id=$14,deposit_method=$15,balance_method=$16,balance_paid=$17,balance_paid_at=$18',
              [apptId, p.id, userId, a.name||'', a.date||'', a.start||10, a.dur||2, a.color||'v', a.status||'pending', a.price||0, a.deposit||0, a.workType||a.type||'', a.notes||a.note||'', a.artistId||p.id, a.depositMethod||'', a.balanceMethod||'', !!a.balancePaid, a.balancePaidDate||null]
            ).then(function() {
              // El seguimiento se dispara al pasar a 'completed' O a 'confirmed' - a petición
              // explícita del dueño: en su estudio "Confirmada" es el estado que usa como
              // sesión terminada, y casi nunca toca "Completada" aparte, así que con solo
              // 'completed' el correo nunca llegaba a salir.
              //
              // El offset de cada regla (día 1/día 3) se cuenta desde ESTE momento (cuando se
              // confirma/completa), no desde la fecha guardada en la cita - también a petición
              // explícita, ver followupDate()/scheduleAftercareEmailsForClient(). Ojo: esto
              // asume que "confirmar" pasa el mismo día de la sesión real (así es como se usa
              // hoy); si algún estudio confirmara reservas con antelación en vez de al terminar
              // la sesión, el correo de cuidados saldría antes de tiempo - no es el caso de
              // esta cuenta, pero quede anotado por si en el futuro hay más de un estudio real
              // usando la plataforma con convenciones distintas.
              var DONE_STATUSES = { completed: true, confirmed: true };
              if (!DONE_STATUSES[oldStatus] && DONE_STATUSES[a.status]) {
                return scheduleAftercareEmails(userId, apptId, a, p, profilesData);
              }
            });
          }).catch(function(){});
        });
        var clientOps = (p.clients||[]).map(function(c) {
          var clientId = c.id !== undefined && c.id !== null ? String(c.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO clients (id,profile_id,user_id,name,phone,email,instagram,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, id) DO UPDATE SET name=$4,phone=$5,email=$6,instagram=$7,notes=$8',
            [clientId, p.id, userId, c.name||'', c.phone||'', c.email||'', c.instagram||'', c.notes||'']
          ).catch(function(){});
        });
        var expenseOps = (p.expenses||[]).map(function(ex) {
          var expId = ex.id !== undefined && ex.id !== null ? String(ex.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO expenses (id,profile_id,user_id,amount,category,description,date,kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, id) DO UPDATE SET amount=$4,category=$5,description=$6,date=$7,kind=$8',
            [expId, p.id, userId, ex.amount||0, ex.cat||'', ex.name||'', ex.date||'', ex.kind||'variable']
          ).catch(function(){});
        });
        // Fase F: Proyectos, Documentos y WhatsApp - mismo respaldo real que ya tienen
        // citas/clientes/gastos, para que sobrevivan aunque se borre este navegador.
        var projectOps = (p.projects||[]).map(function(pr) {
          var prId = pr.id !== undefined && pr.id !== null ? String(pr.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO projects (id,profile_id,user_id,name,client,notes,tags,images) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, id) DO UPDATE SET name=$4,client=$5,notes=$6,tags=$7,images=$8',
            [prId, p.id, userId, pr.name||'', pr.client||'', pr.notes||'', pr.tags||[], pr.images||[]]
          ).catch(function(){});
        });
        var docFileOps = (p.docFiles||[]).map(function(df) {
          var dfId = df.id !== undefined && df.id !== null ? String(df.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO doc_files (id,profile_id,user_id,name,client,date,size,type,url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, id) DO UPDATE SET name=$4,client=$5,date=$6,size=$7,type=$8,url=$9',
            [dfId, p.id, userId, df.name||'', df.client||'', df.date||'', df.size||'', df.type||'', df.url||'']
          ).catch(function(){});
        });
        var consentOps = (p.consents||[]).map(function(cs) {
          var csId = cs.id !== undefined && cs.id !== null ? String(cs.id) : crypto.randomUUID();
          return db.query(
            'INSERT INTO consents (id,profile_id,user_id,client_name,dni,dob,phone,email,address,tattoo_type,zone,size_desc,session_date,artist,price,deposit,medical,checks,created_at_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (user_id, id) DO UPDATE SET client_name=$4,dni=$5,dob=$6,phone=$7,email=$8,address=$9,tattoo_type=$10,zone=$11,size_desc=$12,session_date=$13,artist=$14,price=$15,deposit=$16,medical=$17,checks=$18,created_at_label=$19',
            [csId, p.id, userId, cs.clientName||'', cs.dni||'', cs.dob||'', cs.phone||'', cs.email||'', cs.address||'', cs.tattooType||'', cs.zone||'', cs.size||'', cs.sessionDate||'', cs.artist||'', cs.price||'', cs.deposit||'', cs.medical||'', JSON.stringify(cs.checks||[]), cs.createdAt||'']
          ).catch(function(){});
        });
        var docTemplateOps = (p.docTemplates||[]).map(function(dt) {
          return db.query(
            'INSERT INTO doc_templates (profile_id,user_id,template_id,name,content) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,profile_id,template_id) DO UPDATE SET name=$4,content=$5',
            [p.id, userId, dt.id||'', dt.name||'', dt.content||'']
          ).catch(function(){});
        });
        var waMessageOps = [];
        Object.keys(p.waMessages||{}).forEach(function(clientId) {
          (p.waMessages[clientId]||[]).forEach(function(m) {
            var mId = m.id !== undefined && m.id !== null ? String(m.id) : crypto.randomUUID();
            waMessageOps.push(db.query(
              'INSERT INTO wa_messages (id,profile_id,user_id,client_id,text,dir,ts,auto,auto_id,read) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id, id) DO UPDATE SET text=$5,dir=$6,ts=$7,auto=$8,auto_id=$9,read=$10',
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
        'INSERT INTO pos_sales (id,user_id,item,amount,method,date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, id) DO UPDATE SET item=$3,amount=$4,method=$5,date=$6',
        [saleId, userId, s.item||'', s.amount||0, s.method||'efectivo', s.date||'']
      ).catch(function(){});
    });

    return Promise.all(ops.concat(posSaleOps));
    });
  })
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) {
      if (e.code === 'PLAN_LIMIT') return res.status(403).json({ error: e.message, code: 'PLAN_LIMIT' });
      res.status(500).json({ error: e.message });
    });
});

// ══════════════════════════════════════════
// AISLAMIENTO POR PERFIL: contraseña propia + datos con alcance real
// ══════════════════════════════════════════

// Le dice al frontend si este perfil ya tiene contraseña (para mostrar "crear" o "ingresar").
app.get('/api/profile/:id/has-password', authMiddleware, function(req, res) {
  var profileId = parseInt(req.params.id, 10);
  db.query('SELECT user_id, password_hash FROM profiles WHERE id=$1 AND user_id=$2', [profileId, req.userId])
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

  db.query('SELECT id, user_id, password_hash, is_admin_profile, access_role FROM profiles WHERE id=$1 AND user_id=$2', [profileId, req.userId])
    .then(function(r) {
      if (!r.rows.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      var profile = r.rows[0];
      if (profile.user_id !== req.userId) return res.status(403).json({ error: 'No autorizado' });

      function unlock() {
        if (!req.user.unlockedProfiles) req.user.unlockedProfiles = {};
        req.user.unlockedProfiles[profileId] = true;
        // Fase 1 - roles reales: la sesión del token de login pasa a llevar también qué perfil
        // está activo y con qué rol de permisos, para que el resto de rutas (sync, etc.) sepan
        // si deben limitar lo que este request puede ver/escribir a un solo profile_id.
        req.user.profileId = profileId;
        req.user.accessRole = profile.access_role;
        res.json({ ok: true, isAdminProfile: !!profile.is_admin_profile, accessRole: profile.access_role });
      }

      if (!profile.password_hash) {
        // Primer acceso: esta contraseña queda establecida para este perfil.
        bcrypt.hash(password, 10).then(function(hash) {
          return db.query('UPDATE profiles SET password_hash=$1, password_plain=$2 WHERE id=$3 AND user_id=$4', [hash, password, profileId, req.userId]);
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

// Mapea las filas de Postgres (nombres de columna en snake_case) al formato que ya usa el
// frontend (camelCase) para appts/expenses/consents/docTemplates/waMessages, así el navegador
// no necesita dos formatos distintos según venga de localStorage o del servidor.
function mapApptRow(a) {
  return { id: a.id, name: a.name, date: a.date, start: Number(a.start), dur: Number(a.dur), color: a.color,
    status: a.status, price: Number(a.price), deposit: Number(a.deposit), workType: a.work_type, notes: a.notes,
    artistId: a.artist_id, depositMethod: a.deposit_method, balanceMethod: a.balance_method,
    balancePaid: !!a.balance_paid, balancePaidDate: a.balance_paid_at };
}
function mapExpenseRow(e) {
  return { id: e.id, amount: Number(e.amount), cat: e.category, name: e.description, date: e.date, kind: e.kind };
}
function mapConsentRow(c) {
  return { id: c.id, clientName: c.client_name, dni: c.dni, dob: c.dob, phone: c.phone, email: c.email,
    address: c.address, tattooType: c.tattoo_type, zone: c.zone, size: c.size_desc, sessionDate: c.session_date,
    artist: c.artist, price: c.price, deposit: c.deposit, medical: c.medical, checks: c.checks, createdAt: c.created_at_label };
}
function mapDocTemplateRow(d) { return { id: d.template_id, name: d.name, content: d.content }; }
function groupWaMessages(rows) {
  var out = {};
  rows.forEach(function(m) {
    if (!out[m.client_id]) out[m.client_id] = [];
    out[m.client_id].push({ id: m.id, text: m.text, dir: m.dir, ts: m.ts, auto: !!m.auto, autoId: m.auto_id, read: !!m.read });
  });
  return out;
}

// Datos de un perfil ya desbloqueado: owner ve todo el estudio (igual que hoy); un artista solo
// ve sus propias citas/clientes/gastos/proyectos/documentos/consentimientos/WhatsApp — filtrado
// aquí, en el servidor, para que los datos de otro perfil nunca lleguen al navegador.
app.get('/api/profile/:id/data', authMiddleware, function(req, res) {
  var profileId = parseInt(req.params.id, 10);

  db.query('SELECT id, user_id, is_admin_profile, access_role FROM profiles WHERE id=$1 AND user_id=$2', [profileId, req.userId])
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
        var isOwner = profile.access_role === 'owner';
        var scopeIds = isOwner ? allProfiles.rows.map(function(p) { return p.id; }) : [profileId];
        // AND user_id=$2 en cada filtro: profile_id ya no es único globalmente (ver migración
        // de claves por cuenta), así que sin esto podría traer filas de otra cuenta que
        // coincida por casualidad con el mismo profile_id.
        var apptFilter = (isOwner ? 'profile_id=ANY($1)' : 'profile_id=$1') + ' AND user_id=$2';
        var apptParam = isOwner ? scopeIds : profileId;

        return Promise.all([
          db.query('SELECT * FROM appointments WHERE ' + apptFilter + ' ORDER BY date,start', [apptParam, req.userId]),
          db.query('SELECT * FROM clients WHERE ' + apptFilter, [apptParam, req.userId]),
          db.query('SELECT * FROM expenses WHERE ' + apptFilter, [apptParam, req.userId]),
          db.query('SELECT * FROM projects WHERE ' + apptFilter, [apptParam, req.userId]),
          db.query('SELECT * FROM doc_files WHERE ' + apptFilter, [apptParam, req.userId]),
          db.query('SELECT * FROM consents WHERE ' + apptFilter, [apptParam, req.userId]),
          db.query('SELECT * FROM doc_templates WHERE ' + apptFilter, [apptParam, req.userId]),
          db.query('SELECT * FROM wa_messages WHERE ' + apptFilter, [apptParam, req.userId]),
        ]).then(function(results) {
          res.json({
            roster: roster,
            scope: isOwner ? 'admin' : 'own',
            appointments: results[0].rows.map(mapApptRow),
            clients: results[1].rows,
            expenses: results[2].rows.map(mapExpenseRow),
            projects: results[3].rows,
            docFiles: results[4].rows,
            consents: results[5].rows.map(mapConsentRow),
            docTemplates: results[6].rows.map(mapDocTemplateRow),
            waMessages: groupWaMessages(results[7].rows),
          });
        });
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

// Elimina un perfil de artista de la propia cuenta (self-service del dueño). Borra en cascada
// sus citas/clientes/gastos/proyectos/documentos/consentimientos/WhatsApp (misma cascada que ya
// define el esquema para profile_id). Deliberadamente NO se puede eliminar así: el perfil owner
// (rompería qué perfil es "el Administrador" de la cuenta), ni un perfil con liquidaciones de
// comisión o citas donde figura como artist_id (esas referencias no tienen cascada - por diseño,
// para no borrar en silencio registros de dinero ya facturado/pagado).
app.delete('/api/profile/:id', authMiddleware, function(req, res) {
  var profileId = parseInt(req.params.id, 10);
  if (req.user.accessRole === 'artist') return res.status(403).json({ error: 'Solo el dueño del estudio puede eliminar perfiles' });

  db.query('SELECT id, user_id, is_admin_profile, access_role FROM profiles WHERE id=$1 AND user_id=$2', [profileId, req.userId])
    .then(function(r) {
      if (!r.rows.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      var profile = r.rows[0];
      if (profile.user_id !== req.userId) return res.status(403).json({ error: 'No autorizado' });
      if (profile.is_admin_profile || profile.access_role === 'owner') {
        return res.status(400).json({ error: 'No puedes eliminar el perfil del dueño del estudio' });
      }
      return db.query('DELETE FROM profiles WHERE id=$1 AND user_id=$2', [profileId, req.userId]).then(function() {
        res.json({ ok: true });
      });
    })
    .catch(function(e) {
      if (e.code === '23503') {
        return res.status(409).json({ error: 'No se puede eliminar: este perfil tiene citas asignadas o liquidaciones de comisión registradas. Reasígnalas o elimínalas primero.' });
      }
      res.status(500).json({ error: e.message });
    });
});

app.post('/api/my-profiles/:id/reset-password', authMiddleware, function(req, res) {
  var profileId = parseInt(req.params.id, 10);
  var newPassword = req.body.newPassword || '';
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });

  db.query('SELECT user_id FROM profiles WHERE id=$1 AND user_id=$2', [profileId, req.userId])
    .then(function(r) {
      if (!r.rows.length) return res.status(404).json({ error: 'Perfil no encontrado' });
      if (r.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'No autorizado' });
      return bcrypt.hash(newPassword, 10).then(function(hash) {
        return db.query('UPDATE profiles SET password_hash=$1, password_plain=$2 WHERE id=$3 AND user_id=$4', [hash, newPassword, profileId, req.userId]);
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

// Reporte de ingresos/gastos/comisiones para un periodo. Fase 2 - finanzas por rol: un
// "artist" solo debe ver su propia facturación/comisión, nunca el total del estudio ni el
// desglose de sus compañeros. Esta ruta no la llama hoy el frontend (que calcula el resumen del
// dueño en cliente, a partir de datos ya escopeados por rebuildMergedStore()), pero sigue siendo
// un endpoint autenticado real - cualquier sesión podría llamarla directamente, así que se
// aplica aquí el mismo filtro server-side en vez de confiar en que la UI no la use.
app.get('/api/finance/reports', authMiddleware, function(req, res) {
  var userId = req.userId;
  var range = financePeriodRange(req.query.period, req.query.date);
  var stripeFeePct = parseFloat(req.query.stripeFeePct);
  if (isNaN(stripeFeePct)) stripeFeePct = 1.5;
  var isArtist = req.user.accessRole === 'artist' && req.user.profileId != null;
  var artistFilter = isArtist ? ' AND a.artist_id=$4' : '';
  var apptParams = isArtist ? [userId, range.from, range.to, req.user.profileId] : [userId, range.from, range.to];

  Promise.all([
    db.query(
      "SELECT a.artist_id, p.name AS artist_name, p.commission_pct, COUNT(*) AS cnt, COALESCE(SUM(a.price),0) AS total_price, " +
      "COALESCE(SUM(CASE WHEN a.deposit_method='stripe' THEN a.deposit ELSE 0 END),0) AS stripe_deposit, " +
      "COALESCE(SUM(CASE WHEN a.balance_method='stripe' THEN a.price-a.deposit ELSE 0 END),0) AS stripe_balance " +
      "FROM appointments a LEFT JOIN profiles p ON p.id=a.artist_id AND p.user_id=a.user_id " +
      "WHERE a.user_id=$1 AND a.status='completed' AND a.date>=$2 AND a.date<=$3" + artistFilter + " " +
      "GROUP BY a.artist_id, p.name, p.commission_pct",
      apptParams
    ),
    isArtist ? Promise.resolve({ rows: [{ total: 0 }] }) : db.query('SELECT COALESCE(SUM(amount),0) AS total FROM pos_sales WHERE user_id=$1 AND date>=$2 AND date<=$3', [userId, range.from, range.to]),
    isArtist ? Promise.resolve({ rows: [] }) : db.query(
      "SELECT kind, COALESCE(SUM(amount),0) AS total FROM expenses WHERE user_id=$1 AND date>=$2 AND date<=$3 GROUP BY kind",
      [userId, range.from, range.to]
    ),
    db.query(
      "SELECT COALESCE(SUM(total_comision),0) AS paid FROM commission_settlements WHERE user_id=$1" + (isArtist ? ' AND artist_id=$4' : '') + " AND status='paid' AND period_start>=$2 AND period_end<=$3",
      isArtist ? [userId, range.from, range.to, req.user.profileId] : [userId, range.from, range.to]
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
    var totalCommissionAccrued = perArtist.reduce(function(s, a) { return s + a.totalComision; }, 0);
    var commissionPaid = Number(results[3].rows[0].paid);

    if (isArtist) {
      // Vista de artista: solo su propia comisión, sin totales del estudio (ingresos globales,
      // gastos, beneficio neto ni desglose de otros artistas).
      return res.json({
        range: range,
        scope: 'own',
        mine: perArtist[0] || { artistId: req.user.profileId, name: '', tattoos: 0, totalFacturado: 0, commissionPct: 0, totalComision: 0, stripeAmount: 0 },
        commissions: { totalAccrued: totalCommissionAccrued, totalPaid: commissionPaid, totalPending: totalCommissionAccrued - commissionPaid }
      });
    }

    var tattooIncome = perArtist.reduce(function(s, a) { return s + a.totalFacturado; }, 0);
    var posIncome = Number(results[1].rows[0].total);
    var expensesByKind = { fijo: 0, variable: 0 };
    results[2].rows.forEach(function(r) { expensesByKind[r.kind || 'variable'] = Number(r.total); });
    var totalExpenses = expensesByKind.fijo + expensesByKind.variable;
    var stripeFees = perArtist.reduce(function(s, a) { return s + a.stripeAmount * stripeFeePct / 100; }, 0);
    var netProfit = (tattooIncome + posIncome) - (commissionPaid + totalExpenses + stripeFees);
    res.json({
      range: range,
      scope: 'admin',
      income: { tattoos: tattooIncome, pos: posIncome, total: tattooIncome + posIncome },
      expenses: { fijo: expensesByKind.fijo, variable: expensesByKind.variable, total: totalExpenses },
      commissions: { perArtist: perArtist, totalAccrued: totalCommissionAccrued, totalPaid: commissionPaid, totalPending: totalCommissionAccrued - commissionPaid },
      stripeFees: stripeFees,
      netProfit: netProfit
    });
  }).catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Listar liquidaciones existentes. Fase 2 - un "artist" solo puede ver las suyas: si su rol
// activo es artist, se ignora cualquier artistId que venga en la query y se fuerza al propio,
// para que no pueda leer las liquidaciones de un compañero cambiando el parámetro.
app.get('/api/finance/settlements', authMiddleware, function(req, res) {
  var isArtist = req.user.accessRole === 'artist' && req.user.profileId != null;
  var conditions = ['user_id=$1'];
  var params = [req.userId];
  if (isArtist) {
    params.push(req.user.profileId); conditions.push('artist_id=$' + params.length);
  } else if (req.query.artistId) {
    params.push(req.query.artistId); conditions.push('artist_id=$' + params.length);
  }
  if (req.query.status) { params.push(req.query.status); conditions.push('status=$' + params.length); }
  db.query('SELECT * FROM commission_settlements WHERE ' + conditions.join(' AND ') + ' ORDER BY created_at DESC', params)
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Generar una liquidación real: calculada server-side desde appointments (fuente autoritativa).
// Fase 2: generar/editar/borrar liquidaciones queda reservado al dueño del estudio - es el
// registro oficial de cuánto se le paga a cada artista, no algo que un empleado deba poder
// crear o alterar sobre sí mismo.
app.post('/api/finance/settlements', authMiddleware, function(req, res) {
  if (req.user.accessRole === 'artist') return res.status(403).json({ error: 'Solo el dueño del estudio puede generar liquidaciones' });
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

// Editar una liquidación (marcar pagada/pendiente, o corregir montos/periodo a mano) - owner only, misma razón que generarla.
app.patch('/api/finance/settlements/:id', authMiddleware, function(req, res) {
  if (req.user.accessRole === 'artist') return res.status(403).json({ error: 'Solo el dueño del estudio puede editar liquidaciones' });
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

// Eliminar una liquidación - owner only, misma razón que generarla/editarla.
app.delete('/api/finance/settlements/:id', authMiddleware, function(req, res) {
  if (req.user.accessRole === 'artist') return res.status(403).json({ error: 'Solo el dueño del estudio puede eliminar liquidaciones' });
  db.query('DELETE FROM commission_settlements WHERE id=$1 AND user_id=$2', [req.params.id, req.userId])
    .then(function() { res.json({ success: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Devuelve el estado completo de una cuenta - todos sus perfiles con agenda/clientes/gastos/
// proyectos/documentos/consentimientos/plantillas/WhatsApp, mismo shape que arma el frontend en
// profiles[] localmente. La usan tanto "Ver perfiles" (resumen para el admin) como el modo
// soporte (impersonar), que necesita los datos reales - no solo el conteo - para poder ver la
// app tal cual la ve el usuario.
function getFullAccountData(userId) {
  return db.query('SELECT * FROM profiles WHERE user_id=$1 ORDER BY id ASC', [userId]).then(function(pr) {
    if (!pr.rows.length) return { profiles: [], updated_at: null };
    var profileIds = pr.rows.map(function(p) { return p.id; });
    // AND user_id=$2 en cada una: profile_id ya no es único globalmente (ver migración de
    // claves por cuenta), así que sin esto una cuenta distinta con el mismo profile_id por
    // casualidad se colaría en los datos de esta cuenta.
    return Promise.all([
      db.query('SELECT * FROM appointments WHERE profile_id=ANY($1) AND user_id=$2 ORDER BY date,start', [profileIds, userId]),
      db.query('SELECT * FROM clients WHERE profile_id=ANY($1) AND user_id=$2', [profileIds, userId]),
      db.query('SELECT * FROM expenses WHERE profile_id=ANY($1) AND user_id=$2', [profileIds, userId]),
      db.query('SELECT * FROM projects WHERE profile_id=ANY($1) AND user_id=$2', [profileIds, userId]),
      db.query('SELECT * FROM doc_files WHERE profile_id=ANY($1) AND user_id=$2', [profileIds, userId]),
      db.query('SELECT * FROM consents WHERE profile_id=ANY($1) AND user_id=$2', [profileIds, userId]),
      db.query('SELECT * FROM doc_templates WHERE profile_id=ANY($1) AND user_id=$2', [profileIds, userId]),
      db.query('SELECT * FROM wa_messages WHERE profile_id=ANY($1) AND user_id=$2', [profileIds, userId]),
    ]).then(function(results) {
      var appts = results[0].rows, clients = results[1].rows, expenses = results[2].rows,
        projects = results[3].rows, docFiles = results[4].rows, consents = results[5].rows,
        docTemplates = results[6].rows, waMessages = results[7].rows;
      function mine(rows, p) { return rows.filter(function(r) { return r.profile_id === p.id; }); }
      var profiles = pr.rows.map(function(p) {
        return {
          id: p.id, name: p.name, role: p.role, color: p.color,
          isAdminProfile: !!p.is_admin_profile, accessRole: p.access_role,
          appts: mine(appts, p).map(mapApptRow),
          clients: mine(clients, p),
          expenses: mine(expenses, p).map(mapExpenseRow),
          projects: mine(projects, p),
          docFiles: mine(docFiles, p),
          consents: mine(consents, p).map(mapConsentRow),
          docTemplates: mine(docTemplates, p).map(mapDocTemplateRow),
          waMessages: groupWaMessages(mine(waMessages, p)),
        };
      });
      return { profiles: profiles, updated_at: new Date().toISOString() };
    });
  });
}

// Admin: resumen de una cuenta (usado por "Ver perfiles" en la pestaña Usuarios)
app.get('/api/admin/user-data/:userId', adminMiddleware, function(req, res) {
  getFullAccountData(req.params.userId)
    .then(function(data) {
      if (!data.profiles.length) return res.status(404).json({ error: 'Sin datos guardados aún' });
      res.json(data);
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Modo soporte: el admin entra a ver la cuenta de un usuario tal cual la ve él (solo lectura -
// ver el guard READ_ONLY_SAFE_METHODS más arriba). Cada uso queda registrado en
// admin_access_log (quién, a quién, cuándo) antes de devolver nada, para que quede constancia
// aunque falle algo después.
app.post('/api/admin/impersonate/:userId', adminMiddleware, function(req, res) {
  var targetId = req.params.userId;
  db.query('SELECT id, email, name, is_admin FROM users WHERE id=$1', [targetId]).then(function(r) {
    if (!r.rows.length) { res.status(404).json({ error: 'Usuario no encontrado' }); return null; }
    var target = r.rows[0];
    if (target.is_admin) { res.status(400).json({ error: 'No puedes entrar en modo soporte sobre la cuenta de administrador' }); return null; }
    var adminSession = req.adminUser;
    return db.query(
      'INSERT INTO admin_access_log (admin_id, admin_email, user_id, user_email) VALUES ($1,$2,$3,$4)',
      [adminSession.userId, adminSession.email, target.id, target.email]
    ).then(function() {
      return getFullAccountData(target.id);
    }).then(function(data) {
      var token = crypto.randomUUID();
      authSessions[token] = {
        userId: target.id, email: target.email, name: target.name, isAdmin: false,
        readOnly: true, impersonatedByAdminId: adminSession.userId, impersonatedByAdminEmail: adminSession.email,
      };
      res.json({ token: token, user: { id: target.id, email: target.email, name: target.name }, profiles: data.profiles });
    });
  }).catch(function(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); });
});

// Log de auditoría del modo soporte: quién (admin) entró a ver la cuenta de quién y cuándo.
app.get('/api/admin/access-log', adminMiddleware, function(req, res) {
  db.query('SELECT * FROM admin_access_log ORDER BY created_at DESC LIMIT 200')
    .then(function(r) { res.json(r.rows); })
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
const io = new Server(httpServer, { cors: { origin: process.env.NODE_ENV === 'production' ? PROD_ORIGIN : '*' } });

// rooms: { roomId: { admin: socketId, user: socketId, userId: string } }
const rooms = {};

io.on('connection', function(socket) {
  // Admin solicita ver la pantalla de un usuario - antes cualquiera podía emitir este evento y
  // hacerse pasar por Admin para pedirle a otro usuario que comparta su pantalla. Ahora se exige
  // el token de sesión real y que esa sesión sea efectivamente de administrador.
  socket.on('admin:request-view', function(data) {
    var session = authSessions[data.authToken];
    var isAdm = session && (session.isAdmin || session.email === ADMIN_EMAIL);
    if (!isAdm) return;
    rooms[data.roomId] = { admin: socket.id, userId: data.targetUserId };
    io.to('user:' + data.targetUserId).emit('view:request', { roomId: data.roomId, adminName: 'Admin' });
  });

  // Un cliente solo puede unirse a la "sala" de su propio userId (verificado con su sesión),
  // para que no pueda suscribirse a las solicitudes de ver pantalla dirigidas a otro usuario.
  socket.on('user:join', function(data) {
    var session = authSessions[data.authToken];
    if (!session || session.userId !== data.userId) return;
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
