const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Inicializar tablas
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
}
initDB().catch(console.error);

// Rutas
app.post('/register', async (req, res) => {
  const { name, latitude, longitude } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO users (name, latitude, longitude) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude RETURNING id',
      [name, latitude, longitude]
    );
    res.json({ success: true, user_id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/start', async (req, res) => {
  const { user_id, latitude, longitude } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO time_entries (user_id, start_time, date, latitude, longitude) VALUES ($1, NOW(), CURRENT_DATE, $2, $3) RETURNING id',
      [user_id, latitude, longitude]
    );
    res.json({ success: true, entry_id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/stop', async (req, res) => {
  const { entry_id } = req.body;
  try {
    const entry = await pool.query('SELECT start_time FROM time_entries WHERE id = $1', [entry_id]);
    if (!entry.rows.length) return res.status(404).json({error: 'Not found'});
    
    const endTime = new Date();
    const startTime = new Date(entry.rows[0].start_time);
    let minutes = Math.floor((endTime - startTime) / (1000 * 60));
    minutes = Math.floor(minutes / 15) * 15; // Redondeo hacia abajo cada 15 min
    
    await pool.query('UPDATE time_entries SET end_time = NOW(), duration_minutes = $1 WHERE id = $2', [minutes, entry_id]);
    
    const weekStart = getWeekStart(startTime);
    await updateWeeklySummary((await pool.query('SELECT user_id FROM time_entries WHERE id=$1', [entry_id])).rows[0].user_id, weekStart, minutes);
    
    res.json({ success: true, duration_minutes: minutes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1)); // Lunes
  return d.toISOString().split('T')[0];
}

async function updateWeeklySummary(user_id, week_start, minutes) {
  const existing = await pool.query('SELECT total_minutes FROM weekly_summaries WHERE user_id = $1 AND week_start = $2', [user_id, week_start]);
  if (existing.rows.length) {
    await pool.query('UPDATE weekly_summaries SET total_minutes = total_minutes + $1 WHERE user_id = $2 AND week_start = $3', [minutes, user_id, week_start]);
  } else {
    await pool.query('INSERT INTO weekly_summaries (user_id, week_start, total_minutes) VALUES ($1, $2, $3)', [user_id, week_start, minutes]);
  }
}

app.get('/daily/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const result = await pool.query('SELECT COALESCE(SUM(duration_minutes), 0) as total FROM time_entries WHERE user_id = $1 AND date = CURRENT_DATE', [user_id]);
    res.json({ daily_hours: (result.rows[0].total / 60).toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/weekly/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const weekStart = getWeekStart(new Date());
    const result = await pool.query('SELECT COALESCE(SUM(total_minutes), 0) as total FROM weekly_summaries WHERE user_id = $1 AND week_start = $2', [user_id, weekStart]);
    res.json({ weekly_hours: (result.rows[0].total / 60).toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/history/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM time_entries WHERE user_id = $1 ORDER BY start_time DESC LIMIT 50', [user_id]);
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
      SELECT u.id, u.name, 
             COALESCE(SUM(te.duration_minutes), 0) as total_minutes,
             MAX(te.start_time) as last_entry
      FROM users u
      LEFT JOIN time_entries te ON u.id = te.user_id
      GROUP BY u.id, u.name
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
