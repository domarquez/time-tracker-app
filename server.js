const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const TZ = 'America/La_Paz';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

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

    const today = await getTodayLaPaz();
    const result = await pool.query(
      `INSERT INTO time_entries (user_id, start_time, date, latitude, longitude)
       VALUES ($1, NOW(), $2, $3, $4)
       RETURNING id, start_time`,
      [user_id, today, latitude || null, longitude || null]
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
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Ya hay un turno abierto' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/stop', async (req, res) => {
  const { entry_id, user_id, latitude, longitude } = req.body;
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

    await pool.query(
      `UPDATE time_entries
       SET end_time = NOW(),
           duration_minutes = $1,
           end_latitude = $2,
           end_longitude = $3
       WHERE id = $4`,
      [minutes, latitude ?? null, longitude ?? null, row.id]
    );

    if (latitude != null || longitude != null) {
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
      raw_minutes: detail.raw,
      duration_minutes: minutes,
      duration_hours: fmt.hours,
      message: buildStopMessage(detail),
      entry_id: row.id,
      end_latitude: latitude ?? null,
      end_longitude: longitude ?? null
    });
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

/** Entrada abierta (timer persistente en servidor) */
app.get('/active/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT id AS entry_id, start_time
       FROM time_entries
       WHERE user_id = $1 AND end_time IS NULL
       ORDER BY start_time DESC
       LIMIT 1`,
      [user_id]
    );
    if (!result.rows.length) {
      return res.json({ active: null });
    }
    res.json({
      active: {
        entry_id: result.rows[0].entry_id,
        start_time: result.rows[0].start_time
      }
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
         AND (
           date = $2
           OR (date IS NULL AND (start_time AT TIME ZONE $3)::date = $2)
         )
         AND end_time IS NOT NULL`,
      [user_id, today, TZ]
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
         AND (start_time AT TIME ZONE $2)::date >= $3::date
         AND (start_time AT TIME ZONE $2)::date < ($3::date + INTERVAL '6 days')`,
      [user_id, TZ, weekStart]
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
        AND (te.start_time AT TIME ZONE $3)::date = d.day
       GROUP BY d.day
       ORDER BY d.day`,
      [user_id, weekStart, TZ]
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
app.post('/login-admin', async (req, res) => {
  const { username, password } = req.body;
  if (username === 'diegoadmin' && password === 'admin') {
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

app.listen(port, () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});