const express = require('express');
const pg = require('pg');
const { Pool } = pg;
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();
const notifier = require('./notifier');
const { createWhatsappReports } = require('./whatsapp-reports');
const { laPazWall, entryDay } = require('./tz-sql');

const app = express();
const port = process.env.PORT || 3000;
const TZ = 'America/La_Paz';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// time_entries.start_time/end_time son TIMESTAMP sin zona con hora de pared UTC.
// Leerlos/escribirlos siempre como UTC, sin depender de la zona del proceso Node
// (por defecto pg los interpreta en la zona local del proceso).
pg.types.setTypeParser(1114, (v) => (v == null ? null : new Date(`${v.replace(' ', 'T')}Z`)));
pg.defaults.parseInputDatesAsUTC = true;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Alertas / resúmenes WhatsApp al admin (ver notifier.js / whatsapp-reports.js)
const whatsapp = createWhatsappReports({ pool, TZ, formatHours });

/** Normalize phone: keep leading +, digits only after that (Bolivia-friendly). */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Redondeo a medias horas / horas completas.
 * Por cada hora entera de minutos transcurridos, el resto (0–59):
 * - rem > 50 → +60 min (hora completa)
 * - rem > 20 → +30 min (media hora)
 * - rem ≤ 20 → +0
 */
function roundToHalfOrFullHour(totalMinutes) {
  const m = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const whole = Math.floor(m / 60);
  const rem = m % 60;
  let add = 0;
  if (rem > 50) add = 60;
  else if (rem > 20) add = 30;
  return whole * 60 + add;
}

/** Detalle del redondeo (para mensajes / API). */
function roundingDetail(totalMinutes) {
  const raw = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const whole = Math.floor(raw / 60);
  const rem = raw % 60;
  let add = 0;
  if (rem > 50) add = 60;
  else if (rem > 20) add = 30;
  return { raw, rem, add, rounded: whole * 60 + add };
}

function formatHours(minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  const hoursNum = m / 60;
  // Preferir decimales .0 / .5 cuando aplica; si no, 2 decimales
  const isHalfStep = Math.abs(hoursNum * 2 - Math.round(hoursNum * 2)) < 1e-9;
  const hours = isHalfStep ? hoursNum.toFixed(1) : hoursNum.toFixed(2);
  return { minutes: m, hours, label: `${hours} horas` };
}

function buildStopMessage(detail) {
  const fmt = formatHours(detail.rounded);
  if (detail.add === 60) {
    return `Estuviste ${fmt.label} (redondeo: +${detail.rem} min → hora completa)`;
  }
  if (detail.add === 30) {
    return `Estuviste ${fmt.label} (redondeo: +${detail.rem} min → media hora)`;
  }
  if (detail.rem > 0) {
    return `Estuviste ${fmt.label} (fracción de ${detail.rem} min no acredita; ≤20 min)`;
  }
  return `Estuviste ${fmt.label}`;
}

/** Close duplicate open entries before unique index (keep newest per user). */
async function closeDuplicateOpenEntries() {
  await pool.query(`
    WITH ranked AS (
      SELECT id, user_id, start_time,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY start_time DESC, id DESC) AS rn
      FROM time_entries
      WHERE end_time IS NULL
    ),
    to_close AS (
      SELECT id, start_time FROM ranked WHERE rn > 1
    )
    UPDATE time_entries te
    SET end_time = te.start_time,
        duration_minutes = 0
    FROM to_close c
    WHERE te.id = c.id
  `);
}

// Inicializar tablas (migración segura)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP,
      duration_minutes INTEGER,
      date DATE,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS weekly_summaries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      week_start DATE NOT NULL,
      total_minutes INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // phone: nullable first for existing rows, then unique
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
  `);

  // GPS al apagar (fin de turno)
  await pool.query(`
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS end_latitude DOUBLE PRECISION;
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS end_longitude DOUBLE PRECISION;
  `);

  // Observación / motivo de corte + acuse nocturno
  await pool.query(`
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS observation TEXT;
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS stop_reason TEXT;
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS night_acked_phase TEXT;
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS night_ask_at TIMESTAMPTZ;
    ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS night_ask_phase TEXT;
  `);

  // Unique index on phone (allows multiple NULLs in Postgres)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
  `);

  // Clean legacy duplicate open shifts, then enforce one open entry per user
  await closeDuplicateOpenEntries();
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_open_per_user
    ON time_entries (user_id) WHERE end_time IS NULL;
  `);

  // Marcas de envío de notificaciones (resúmenes WhatsApp): evita duplicar tras reinicios
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      ref_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      claimed_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      UNIQUE (kind, ref_date)
    );
  `);

  console.log('Base de datos lista');
}
initDB().catch((err) => {
  console.error('Error initDB:', err);
});

/** Monday (YYYY-MM-DD) of current week in America/La_Paz */
async function getWeekStartLaPaz(dateInput) {
  const r = await pool.query(
    `SELECT (
       date_trunc('week', ($1::timestamptz AT TIME ZONE $2))::date
     ) AS week_start`,
    [dateInput || new Date().toISOString(), TZ]
  );
  return r.rows[0].week_start;
}

async function getTodayLaPaz() {
  const r = await pool.query(
    `SELECT (NOW() AT TIME ZONE $1)::date AS today`,
    [TZ]
  );
  return r.rows[0].today;
}

/**
 * Login / registro por teléfono.
 * - Teléfono obligatorio (es la clave y la "contraseña").
 * - Usuario nuevo: requiere name.
 * - Usuario existente: phone solo (opcional actualizar name).
 */
async function handleAuth(req, res) {
  const phone = normalizePhone(req.body.phone || req.body.password || '');
  let name = (req.body.name || '').trim();
  const { latitude, longitude } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'El teléfono es obligatorio' });
  }

  try {
    const existing = await pool.query(
      'SELECT id, name, phone FROM users WHERE phone = $1',
      [phone]
    );

    if (existing.rows.length) {
      const user = existing.rows[0];
      if (name && name !== user.name) {
        await pool.query(
          'UPDATE users SET name = $1, latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude) WHERE id = $4',
          [name, latitude, longitude, user.id]
        );
        user.name = name;
      } else if (latitude != null || longitude != null) {
        await pool.query(
          'UPDATE users SET latitude = COALESCE($1, latitude), longitude = COALESCE($2, longitude) WHERE id = $3',
          [latitude, longitude, user.id]
        );
      }
      return res.json({
        success: true,
        user_id: user.id,
        name: user.name,
        phone: user.phone,
        is_new: false
      });
    }

    // Nuevo usuario
    if (!name) {
      return res.status(400).json({
        error: 'Nombre requerido para registrarse por primera vez',
        needs_name: true
      });
    }

    let insertName = name;
    try {
      const result = await pool.query(
        `INSERT INTO users (name, phone, latitude, longitude)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, phone`,
        [insertName, phone, latitude || null, longitude || null]
      );
      return res.json({
        success: true,
        user_id: result.rows[0].id,
        name: result.rows[0].name,
        phone: result.rows[0].phone,
        is_new: true
      });
    } catch (e) {
      if (e.code === '23505') {
        insertName = `${name} (${phone})`;
        const result = await pool.query(
          `INSERT INTO users (name, phone, latitude, longitude)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, phone`,
          [insertName, phone, latitude || null, longitude || null]
        );
        return res.json({
          success: true,
          user_id: result.rows[0].id,
          name: result.rows[0].name,
          phone: result.rows[0].phone,
          is_new: true
        });
      }
      throw e;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}


/**
 * Close an open entry without GPS (server auto-stop / cron).
 * Rounding rules unchanged. end lat/lng stay null.
 */
async function closeEntryAuto(row, { stop_reason, observation, endAt, phase } = {}) {
  const endTime = endAt ? new Date(endAt) : new Date();
  const startTime = new Date(row.start_time);
  const rawMinutes = Math.max(0, Math.floor((endTime - startTime) / (1000 * 60)));
  const detail = roundingDetail(rawMinutes);
  const minutes = detail.rounded;
  const obs = observation || null;
  const reason = stop_reason || 'auto';

  const upd = await pool.query(
    `UPDATE time_entries
     SET end_time = $1,
         duration_minutes = $2,
         observation = COALESCE($3, observation),
         stop_reason = COALESCE($4, stop_reason),
         night_ask_at = NULL,
         night_ask_phase = NULL
     WHERE id = $5 AND end_time IS NULL
     RETURNING id`,
    [endTime.toISOString(), minutes, obs, reason, row.id]
  );

  // Si otro proceso ya cerró el turno, no sumar de nuevo al semanal
  if (upd.rows.length) {
    const weekStart = await getWeekStartLaPaz(startTime.toISOString());
    await updateWeeklySummary(row.user_id, weekStart, minutes);
    whatsapp.alertAutoCut(row.user_id, { observation: obs, stop_reason: reason, minutes, entryId: row.id, endAt: endTime });
  }

  const fmt = formatHours(minutes);
  return {
    success: true,
    auto: true,
    entry_id: row.id,
    user_id: row.user_id,
    raw_minutes: detail.raw,
    duration_minutes: minutes,
    duration_hours: fmt.hours,
    message: buildStopMessage(detail),
    observation: obs,
    stop_reason: reason,
    phase: phase || 'auto_closed'
  };
}

/**
 * Política nocturna (America/La_Paz). Los turnos PUEDEN pasar la medianoche:
 * no hay corte fijo a las 00:00, pero el trabajador tiene que ir confirmando.
 *
 * Checkpoints, en horas desde la medianoche del día de INICIO del turno:
 *   20 (20:00), 23 (23:00), 24 (00:00 del día siguiente), 25 (01:00), …
 * cada NIGHT_ASK_EVERY_MIN minutos después de las 23:00 (default 60).
 * Solo cuentan los checkpoints posteriores al inicio del turno.
 * - En cada checkpoint se pregunta "¿Seguís?" (night_ask_phase = checkpoint).
 * - Sin respuesta en NIGHT_ASK_TIMEOUT_MIN (default 15) → corte automático con observación.
 * - "Seguir" (/night-continue) → night_acked_phase = checkpoint; no se vuelve a
 *   preguntar hasta el siguiente.
 * - Tope de seguridad: MAX_SHIFT_HOURS (default 16) → corte automático al llegar
 *   a ese largo (end_time = inicio + tope; no se acreditan minutos de más).
 * Todas las horas del turno cuentan para el día en que EMPEZÓ (columna date).
 */
function envNum(name, fallback, min) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
function nightConfig() {
  return {
    everyMin: envNum('NIGHT_ASK_EVERY_MIN', 60, 15),
    timeoutMin: envNum('NIGHT_ASK_TIMEOUT_MIN', 15, 1),
    maxShiftMin: Math.round(envNum('MAX_SHIFT_HOURS', 16, 1) * 60)
  };
}

/** Minuto (desde la medianoche del día de inicio) de cada checkpoint, ordenados. */
function nightCheckpoints(maxMin, everyMin) {
  const cps = [20 * 60, 23 * 60];
  for (let m = 23 * 60 + everyMin; m <= maxMin; m += everyMin) cps.push(m);
  return cps;
}

/** Código de fase = minutos desde la medianoche del día de inicio / 60 ("20", "23", "24", "25"…; "24.5" si every=30). */
const phaseOf = (min) => String(min / 60);
const minOfPhase = (phase) => {
  const n = Number(phase);
  return Number.isFinite(n) ? Math.round(n * 60) : null;
};
/** HH:MM La Paz de un checkpoint (24 → 00:00). */
function cpLabel(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function askMessage(cpMin) {
  if (cpMin === 20 * 60) return 'Son más de las 20:00 y el turno sigue abierto. ¿Seguís contando horas?';
  const dia = cpMin >= 1440 ? ' (ya es el día siguiente; las horas cuentan para el día en que prendiste)' : '';
  return `Son las ${cpLabel(cpMin)} y el turno sigue abierto${dia}. ¿Seguís trabajando?`;
}

/** Estado del turno en minutos desde la medianoche La Paz de su día de inicio. */
async function shiftClock(entryId, now = new Date()) {
  const r = await pool.query(
    `SELECT te.id, te.user_id, te.start_time,
            ${entryDay('te')}::text AS start_date,
            to_char(${laPazWall('te.start_time')}, 'HH24:MI') AS start_hm,
            FLOOR(EXTRACT(EPOCH FROM (${laPazWall('te.start_time')} - ${entryDay('te')}::timestamp)) / 60)::int AS start_min,
            FLOOR(EXTRACT(EPOCH FROM (($3::timestamptz AT TIME ZONE $2) - ${entryDay('te')}::timestamp)) / 60)::int AS now_min,
            te.night_acked_phase, te.night_ask_phase, te.night_ask_at,
            EXTRACT(EPOCH FROM ($3::timestamptz - te.night_ask_at)) AS ask_age_sec
     FROM time_entries te WHERE te.id = $1 AND te.end_time IS NULL`,
    [entryId, TZ, now.toISOString()]
  );
  return r.rows[0] || null;
}

/**
 * Evaluate night policy for one open entry.
 * Returns { action: 'none'|'ask'|'auto_stopped', phase?, ask_continue?, ... }
 */
async function evaluateNightForEntry(row) {
  const now = new Date();
  const s = await shiftClock(row.id, now);
  if (!s) return { action: 'none', ask_continue: false, phase: null };
  const cfg = nightConfig();
  const startMin = Number(s.start_min);
  const nowMin = Number(s.now_min);
  const elapsed = nowMin - startMin;

  // Tope de seguridad: largo máximo del turno
  if (elapsed >= cfg.maxShiftMin) {
    const endAt = new Date(new Date(s.start_time).getTime() + cfg.maxShiftMin * 60000);
    const closed = await closeEntryAuto(s, {
      stop_reason: 'tope_turno',
      observation: `Corte automático: tope de ${formatHours(cfg.maxShiftMin).hours.replace(/\.0$/, '')} h de turno`,
      endAt,
      phase: 'max_shift'
    });
    return { action: 'auto_stopped', ask_continue: false, ...closed };
  }

  const acked = minOfPhase(s.night_acked_phase);
  const askMin = minOfPhase(s.night_ask_phase);
  const askAgeSec = s.ask_age_sec != null ? Number(s.ask_age_sec) : null;

  // Pregunta pendiente vencida sin respuesta → cortar
  if (askMin != null && askAgeSec != null && askAgeSec >= cfg.timeoutMin * 60
      && (acked == null || acked < askMin)) {
    const closed = await closeEntryAuto(s, {
      stop_reason: 'sin_respuesta_noche',
      observation: `Corte automático: sin respuesta a las ${cpLabel(askMin)}`,
      // Se corta al vencer la espera (no se acreditan horas sin confirmar si el cron se atrasó)
      endAt: new Date(Math.min(now.getTime(), new Date(s.night_ask_at).getTime() + cfg.timeoutMin * 60000)),
      phase: s.night_ask_phase
    });
    return { action: 'auto_stopped', ask_continue: false, ...closed };
  }

  // Último checkpoint ya alcanzado y posterior al inicio del turno
  const due = nightCheckpoints(startMin + cfg.maxShiftMin, cfg.everyMin)
    .filter((m) => m > startMin && m <= nowMin);
  const current = due.length ? due[due.length - 1] : null;
  if (current == null || (acked != null && acked >= current)) {
    return { action: 'none', ask_continue: false, phase: null };
  }

  const phase = phaseOf(current);
  if (askMin !== current) {
    await pool.query(
      `UPDATE time_entries
       SET night_ask_at = $3, night_ask_phase = $2
       WHERE id = $1 AND end_time IS NULL`,
      [s.id, phase, now.toISOString()]
    );
    whatsapp.alertAsk(s.id, phase);
  }
  return {
    action: 'ask',
    ask_continue: true,
    phase,
    entry_id: s.id,
    message: askMessage(current)
  };
}

/** Cron: cortes por pregunta nocturna sin respuesta / tope de turno. */
async function runNightCron() {
  try {
    const open = await pool.query(
      `SELECT id, user_id, start_time FROM time_entries WHERE end_time IS NULL`
    );
    for (const row of open.rows) {
      await evaluateNightForEntry(row);
    }
  } catch (e) {
    console.error('night cron:', e.message);
  }
}

app.post('/register', handleAuth);
app.post('/login', handleAuth);

/** Actualizar ubicación del usuario (abrir app / restaurar sesión). */
app.post('/location', async (req, res) => {
  const { user_id, latitude, longitude } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
  if (latitude == null && longitude == null) {
    return res.status(400).json({ error: 'latitude/longitude requeridos' });
  }
  try {
    const result = await pool.query(
      `UPDATE users
       SET latitude = COALESCE($1, latitude),
           longitude = COALESCE($2, longitude)
       WHERE id = $3
       RETURNING id, latitude, longitude`,
      [latitude ?? null, longitude ?? null, user_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({
      success: true,
      user_id: result.rows[0].id,
      latitude: result.rows[0].latitude,
      longitude: result.rows[0].longitude
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/start', async (req, res) => {
  const { user_id, latitude, longitude } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id requerido' });
  if (latitude == null || longitude == null || latitude === '' || longitude === '') {
    return res.status(400).json({
      error: 'Tenés que activar la ubicación (GPS) para registrar el turno.'
    });
  }

  try {
    const open = await pool.query(
      'SELECT id, start_time FROM time_entries WHERE user_id = $1 AND end_time IS NULL LIMIT 1',
      [user_id]
    );
    if (open.rows.length) {
      return res.status(409).json({
        error: 'Ya hay un turno abierto',
        entry_id: open.rows[0].id,
        start_time: open.rows[0].start_time
      });
    }

    // Turno nuevo siempre separado: su día es la fecha La Paz en que se prende
    const startAt = new Date();
    const today = whatsapp.laPazParts(startAt).date;
    const result = await pool.query(
      `INSERT INTO time_entries (user_id, start_time, date, latitude, longitude)
       VALUES ($1, $5, $2::date, $3, $4)
       RETURNING id, start_time`,
      [user_id, today, latitude || null, longitude || null, startAt.toISOString()]
    );

    if (latitude != null || longitude != null) {
      await pool.query(
        `UPDATE users SET latitude = COALESCE($1, latitude), longitude = COALESCE($2, longitude) WHERE id = $3`,
        [latitude, longitude, user_id]
      );
    }

    res.json({
      success: true,
      entry_id: result.rows[0].id,
      start_time: result.rows[0].start_time
    });
    whatsapp.alertStart(user_id, startAt);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Ya hay un turno abierto' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/stop', async (req, res) => {
  const {
    entry_id,
    user_id,
    latitude,
    longitude,
    observation,
    stop_reason,
    auto
  } = req.body;
  const isAuto = auto === true || auto === 'true' || stop_reason === 'sin_respuesta_noche'
    || stop_reason === 'medianoche';

  // GPS obligatorio solo en apagado iniciado por el usuario
  if (!isAuto && (latitude == null || longitude == null || latitude === '' || longitude === '')) {
    return res.status(400).json({
      error: 'Tenés que activar la ubicación (GPS) para registrar el turno.'
    });
  }
  try {
    let entry;
    if (entry_id) {
      entry = await pool.query(
        'SELECT id, user_id, start_time FROM time_entries WHERE id = $1 AND end_time IS NULL',
        [entry_id]
      );
    } else if (user_id) {
      entry = await pool.query(
        'SELECT id, user_id, start_time FROM time_entries WHERE user_id = $1 AND end_time IS NULL ORDER BY start_time DESC LIMIT 1',
        [user_id]
      );
    } else {
      return res.status(400).json({ error: 'entry_id o user_id requerido' });
    }

    if (!entry.rows.length) {
      return res.status(404).json({ error: 'No hay turno abierto' });
    }

    const row = entry.rows[0];
    const endTime = new Date();
    const startTime = new Date(row.start_time);
    const rawMinutes = Math.floor((endTime - startTime) / (1000 * 60));
    const detail = roundingDetail(rawMinutes);
    const minutes = detail.rounded;
    const reason = stop_reason || (isAuto ? 'auto' : 'manual');
    const obs = observation || null;

    const upd = await pool.query(
      `UPDATE time_entries
       SET end_time = $7,
           duration_minutes = $1,
           end_latitude = $2,
           end_longitude = $3,
           observation = COALESCE($4, observation),
           stop_reason = $5,
           night_ask_at = NULL,
           night_ask_phase = NULL
       WHERE id = $6 AND end_time IS NULL
       RETURNING id`,
      [minutes, isAuto ? null : (latitude ?? null), isAuto ? null : (longitude ?? null), obs, reason, row.id,
        endTime.toISOString()]
    );
    // Otro proceso (cron nocturno / doble click) ya lo cerró: no sumar dos veces
    if (!upd.rows.length) {
      return res.status(404).json({ error: 'No hay turno abierto' });
    }

    if (!isAuto && (latitude != null || longitude != null)) {
      await pool.query(
        `UPDATE users SET latitude = COALESCE($1, latitude), longitude = COALESCE($2, longitude) WHERE id = $3`,
        [latitude, longitude, row.user_id]
      );
    }

    const weekStart = await getWeekStartLaPaz(startTime.toISOString());
    await updateWeeklySummary(row.user_id, weekStart, minutes);

    const fmt = formatHours(minutes);
    res.json({
      success: true,
      auto: !!isAuto,
      raw_minutes: detail.raw,
      duration_minutes: minutes,
      duration_hours: fmt.hours,
      message: buildStopMessage(detail),
      entry_id: row.id,
      observation: obs,
      stop_reason: reason,
      end_latitude: isAuto ? null : (latitude ?? null),
      end_longitude: isAuto ? null : (longitude ?? null)
    });
    if (isAuto) {
      whatsapp.alertAutoCut(row.user_id, { observation: obs, stop_reason: reason, minutes, entryId: row.id, endAt: endTime });
    } else {
      whatsapp.alertStop(row.user_id, minutes, endTime);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Auto-stop sin GPS (cliente o admin). Usa las mismas reglas de redondeo.
 * Body: { entry_id? , user_id?, observation?, stop_reason? }
 */
app.post('/auto-stop', async (req, res) => {
  const { entry_id, user_id, observation, stop_reason } = req.body;
  try {
    let entry;
    if (entry_id) {
      entry = await pool.query(
        'SELECT id, user_id, start_time FROM time_entries WHERE id = $1 AND end_time IS NULL',
        [entry_id]
      );
    } else if (user_id) {
      entry = await pool.query(
        'SELECT id, user_id, start_time FROM time_entries WHERE user_id = $1 AND end_time IS NULL ORDER BY start_time DESC LIMIT 1',
        [user_id]
      );
    } else {
      return res.status(400).json({ error: 'entry_id o user_id requerido' });
    }
    if (!entry.rows.length) {
      return res.status(404).json({ error: 'No hay turno abierto' });
    }
    const closed = await closeEntryAuto(entry.rows[0], {
      stop_reason: stop_reason || 'sin_respuesta_noche',
      observation: observation || 'Corte automático: sin respuesta a las 20h'
    });
    res.json(closed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Usuario responde "Seguir" al chequeo nocturno (fase 20 o 23).
 * Body: { user_id, entry_id?, phase: '20'|'23' }
 */
app.post('/night-continue', async (req, res) => {
  const { user_id, entry_id, phase } = req.body;
  const p = String(phase || '');
  const pMin = minOfPhase(p);
  if (!p || pMin == null || pMin < 20 * 60) {
    return res.status(400).json({ error: 'phase inválida (20, 23, 24, 25…)' });
  }
  if (!user_id && !entry_id) {
    return res.status(400).json({ error: 'user_id o entry_id requerido' });
  }
  try {
    // No permitir "Seguir" para un checkpoint anterior al ya confirmado
    const result = await pool.query(
      `UPDATE time_entries
       SET night_acked_phase = $1,
           night_ask_at = NULL,
           night_ask_phase = NULL
       WHERE ${entry_id ? 'id' : 'user_id'} = $2 AND end_time IS NULL
         AND (night_acked_phase IS NULL OR night_acked_phase !~ '^[0-9.]+$'
              OR night_acked_phase::numeric <= $1::numeric)
       RETURNING id, user_id, night_acked_phase`,
      [p, entry_id || user_id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'No hay turno abierto' });
    }
    const cfg = nightConfig();
    const next = nightCheckpoints(pMin + cfg.everyMin * 2, cfg.everyMin).find((m) => m > pMin);
    res.json({
      success: true,
      entry_id: result.rows[0].id,
      night_acked_phase: result.rows[0].night_acked_phase,
      message: `Seguís contando. Te preguntamos de nuevo a las ${cpLabel(next)}. `
        + 'Todas las horas cuentan para el día en que prendiste.'
    });
    whatsapp.alertContinue(result.rows[0].id, p);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function updateWeeklySummary(user_id, week_start, minutes) {
  const existing = await pool.query(
    'SELECT total_minutes FROM weekly_summaries WHERE user_id = $1 AND week_start = $2',
    [user_id, week_start]
  );
  if (existing.rows.length) {
    await pool.query(
      'UPDATE weekly_summaries SET total_minutes = total_minutes + $1 WHERE user_id = $2 AND week_start = $3',
      [minutes, user_id, week_start]
    );
  } else {
    await pool.query(
      'INSERT INTO weekly_summaries (user_id, week_start, total_minutes) VALUES ($1, $2, $3)',
      [user_id, week_start, minutes]
    );
  }
}

/** Entrada abierta (timer persistente en servidor) + chequeo nocturno */
app.get('/active/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, user_id, start_time, night_acked_phase, night_ask_at, night_ask_phase
       FROM time_entries
       WHERE user_id = $1 AND end_time IS NULL
       ORDER BY start_time DESC
       LIMIT 1`,
      [user_id]
    );
    if (!result.rows.length) {
      return res.json({ active: null, night: { action: 'none', ask_continue: false } });
    }

    const row = result.rows[0];
    const night = await evaluateNightForEntry(row);

    if (night.action === 'auto_stopped') {
      return res.json({
        active: null,
        night: {
          action: 'auto_stopped',
          ask_continue: false,
          phase: night.phase || 'auto_closed',
          observation: night.observation,
          stop_reason: night.stop_reason,
          duration_minutes: night.duration_minutes,
          duration_hours: night.duration_hours,
          message: night.message
        }
      });
    }

    res.json({
      active: {
        entry_id: row.id,
        start_time: row.start_time,
        night_acked_phase: row.night_acked_phase
      },
      night: {
        action: night.action,
        ask_continue: !!night.ask_continue,
        phase: night.phase,
        message: night.message || null
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Chequeo nocturno explícito (flags para modal / auto-corte).
 * GET /night-check/:user_id → { ask_continue, phase, ... }
 */
app.get('/night-check/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, user_id, start_time, night_acked_phase, night_ask_at, night_ask_phase
       FROM time_entries
       WHERE user_id = $1 AND end_time IS NULL
       ORDER BY start_time DESC
       LIMIT 1`,
      [user_id]
    );
    if (!result.rows.length) {
      return res.json({
        active: false,
        ask_continue: false,
        phase: null,
        action: 'none'
      });
    }
    const night = await evaluateNightForEntry(result.rows[0]);
    if (night.action === 'auto_stopped') {
      return res.json({
        active: false,
        ask_continue: false,
        phase: night.phase || 'auto_closed',
        action: 'auto_stopped',
        observation: night.observation,
        stop_reason: night.stop_reason,
        duration_minutes: night.duration_minutes,
        duration_hours: night.duration_hours,
        message: night.message
      });
    }
    res.json({
      active: true,
      entry_id: result.rows[0].id,
      ask_continue: !!night.ask_continue,
      phase: night.phase,
      action: night.action,
      message: night.message || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/daily/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const today = await getTodayLaPaz();
    const result = await pool.query(
      `SELECT COALESCE(SUM(duration_minutes), 0) AS total
       FROM time_entries
       WHERE user_id = $1
         AND ${entryDay('')} = $2::date
         AND end_time IS NOT NULL`,
      [user_id, today]
    );
    const fmt = formatHours(result.rows[0].total);
    res.json({
      daily_hours: fmt.hours,
      daily_minutes: fmt.minutes,
      label: `Estuvo ${fmt.label}`,
      date: today
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/weekly/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const weekStart = await getWeekStartLaPaz();
    // Lunes–Sábado: recalcular desde time_entries por zona La Paz
    const result = await pool.query(
      `SELECT COALESCE(SUM(duration_minutes), 0) AS total
       FROM time_entries
       WHERE user_id = $1
         AND end_time IS NOT NULL
         AND ${entryDay('')} >= $2::date
         AND ${entryDay('')} < ($2::date + 6)`,
      [user_id, weekStart]
    );
    const fmt = formatHours(result.rows[0].total);
    res.json({
      weekly_hours: fmt.hours,
      weekly_minutes: fmt.minutes,
      label: `Estuvo ${fmt.label}`,
      week_start: weekStart
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Totales día a día Lun–Sáb de la semana actual (La Paz) */
app.get('/week-days/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const weekStart = await getWeekStartLaPaz();
    const result = await pool.query(
      `WITH days AS (
         SELECT generate_series($2::date, $2::date + INTERVAL '5 days', INTERVAL '1 day')::date AS day
       )
       SELECT d.day::text AS date,
              COALESCE(SUM(te.duration_minutes), 0)::int AS minutes
       FROM days d
       LEFT JOIN time_entries te
         ON te.user_id = $1
        AND te.end_time IS NOT NULL
        AND ${entryDay('te')} = d.day
       GROUP BY d.day
       ORDER BY d.day`,
      [user_id, weekStart]
    );

    const days = result.rows.map((r) => {
      const fmt = formatHours(r.minutes);
      return {
        date: r.date,
        minutes: fmt.minutes,
        hours: fmt.hours,
        label: `estuvo ${fmt.label}`
      };
    });

    const totalMinutes = days.reduce((a, d) => a + d.minutes, 0);
    const totalFmt = formatHours(totalMinutes);

    res.json({
      week_start: weekStart,
      days,
      weekly_hours: totalFmt.hours,
      weekly_minutes: totalFmt.minutes
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/history/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM time_entries WHERE user_id = $1 ORDER BY start_time DESC LIMIT 50',
      [user_id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === ADMIN ROUTES ===
const ADMIN_USERNAME = 'diegoadmin';
const ADMIN_PASSWORD = 'admin';

/** Chequeo admin simple (mismo criterio que /login-admin; username opcional). */
function isAdminBody(body = {}) {
  const { username, password } = body;
  if (password !== ADMIN_PASSWORD) return false;
  return username == null || username === '' || username === ADMIN_USERNAME;
}

app.post('/login-admin', async (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    res.json({ success: true, isAdmin: true });
  } else {
    res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
  }
});

app.get('/all-users', async (req, res) => {
  try {
    const users = await pool.query(`
      SELECT u.id, u.name, u.phone,
             COALESCE(SUM(te.duration_minutes), 0) as total_minutes,
             MAX(te.start_time) as last_entry
      FROM users u
      LEFT JOIN time_entries te ON u.id = te.user_id
      GROUP BY u.id, u.name, u.phone
      ORDER BY u.name
    `);
    res.json(users.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Prueba de WhatsApp al admin. Body: { password: 'admin', username? } */
app.post('/admin/test-whatsapp', (req, res) => {
  if (!isAdminBody(req.body)) {
    return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
  }
  const st = notifier.status();
  if (!st.enabled) {
    return res.status(503).json({
      success: false,
      error: st.configured
        ? 'WhatsApp deshabilitado (WHATSAPP_ENABLED=false)'
        : `WhatsApp sin configurar para el proveedor "${st.provider}" (Evolution: EVOLUTION_BASE_URL + EVOLUTION_API_KEY; CallMeBot: CALLMEBOT_APIKEY; TextMeBot: TEXTMEBOT_APIKEY)`,
      whatsapp: st
    });
  }
  // No esperar al proveedor: se encola y se responde enseguida
  notifier.notify('✅ Prueba de Control de Horas', { tag: 'test' });
  res.status(202).json({ success: true, queued: true, whatsapp: st });
});

/**
 * Vista previa (y envío opcional) de resúmenes, sin tocar notification_log.
 * Body: { password, kind: 'daily'|'weekly', date?: 'YYYY-MM-DD', send?: true }
 */
app.post('/admin/whatsapp-summary', async (req, res) => {
  if (!isAdminBody(req.body)) {
    return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
  }
  const kind = req.body.kind === 'weekly' ? 'weekly' : 'daily';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || ''))
    ? req.body.date
    : whatsapp.laPazParts().date;
  try {
    let text;
    if (kind === 'weekly') {
      const wd = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0=dom
      const monday = whatsapp.addDays(date, wd === 0 ? -6 : 1 - wd);
      text = await whatsapp.buildWeeklySummary(monday);
    } else {
      text = await whatsapp.buildDailySummary(date);
    }
    const send = req.body.send === true || req.body.send === 'true';
    if (send) notifier.notify(text, { tag: `manual-${kind}` });
    res.json({ success: true, kind, date, sent: send && notifier.status().enabled, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// WhatsApp: aviso "sigue prendido" 20:00, diario 21:30 lun–sáb, semanal sáb 21:45 (La Paz)
whatsapp.startScheduler();

// Cron cada 60s: cortes nocturnos / medianoche aunque el cliente no pollee
setInterval(runNightCron, 60 * 1000);
// Primera pasada un poco después de arrancar (dar tiempo a initDB)
setTimeout(runNightCron, 5000);

app.listen(port, () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});