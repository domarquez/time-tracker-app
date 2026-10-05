/**
 * Panel y comandos del administrador.
 *
 * - Autenticación: ADMIN_PASSWORD (env). Si no está definida se usa 'admin' y se
 *   avisa en el log y en el panel. Header `x-admin-password` (o body.password).
 *   10 intentos fallidos por IP en 15 min → 429.
 * - Pantalla: GET /admin (admin.html).
 * - API simple para curl / asistente: POST /admin/shift/start, POST /admin/shift/stop,
 *   GET|POST /admin/status  ({ password, worker: nombre|teléfono, time?: 'HH:MM', note? }).
 * - API del panel bajo /admin/api/* (ver README).
 * - Webhook opcional de Evolution: POST /webhook/evolution?token=EVOLUTION_WEBHOOK_TOKEN
 *   Solo acepta mensajes de ADMIN_WHATSAPP_PHONE; comandos "inicio <nombre|todos>",
 *   "fin <nombre|todos>", "estado", "ayuda". Mensajes que no son comandos se ignoran
 *   en silencio (la instancia es compartida con otro proyecto).
 */
const crypto = require('crypto');
const path = require('path');
const { laPazWall, entryDay } = require('./tz-sql');

function registerAdmin(app, {
  pool, whatsapp, notifier, startShift, stopShift, upsertWorker, formatHours
}) {
  const weakPassword = !String(process.env.ADMIN_PASSWORD || '').trim();
  if (weakPassword) {
    console.warn('[admin] ⚠️ ADMIN_PASSWORD no está definida: se usa la contraseña por defecto "admin". Definila en Railway.');
  }
  const adminPassword = () => String(process.env.ADMIN_PASSWORD || '').trim() || 'admin';

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

  // ---- Límite de intentos fallidos por IP ----
  const fails = new Map();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_FAILS = 10;
  function blocked(ip) {
    const f = fails.get(ip);
    if (!f) return false;
    if (Date.now() - f.first > WINDOW_MS) { fails.delete(ip); return false; }
    return f.count >= MAX_FAILS;
  }
  function recordFail(ip) {
    const f = fails.get(ip);
    if (!f || Date.now() - f.first > WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
    else f.count += 1;
  }

  /** true si la request trae la contraseña de admin correcta. */
  function checkAdmin(req) {
    const pwd = req.get('x-admin-password') ?? (req.body && req.body.password);
    if (pwd == null || pwd === '') return false;
    return safeEqual(pwd, adminPassword());
  }

  function requireAdmin(req, res, next) {
    const ip = req.ip || 'unknown';
    if (blocked(ip)) return res.status(429).json({ success: false, error: 'Demasiados intentos. Probá en 15 minutos.' });
    if (!checkAdmin(req)) {
      recordFail(ip);
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }
    fails.delete(ip);
    next();
  }

  const h = (m) => `${formatHours(m).hours} h`;

  /** Estado de todos los usuarios para hoy (La Paz). */
  async function workersOverview(now = new Date()) {
    const today = whatsapp.laPazParts(now).date;
    const monday = whatsapp.mondayOf(today);
    const r = await pool.query(
      `SELECT u.id, u.name, u.phone, u.hourly_rate::float AS hourly_rate,
              o.id AS open_entry_id, o.started_by AS open_started_by,
              to_char(${laPazWall('o.start_time')}, 'HH24:MI') AS open_start_hm,
              ${entryDay('o')}::text AS open_day,
              COALESCE(t.day_min, 0)::int AS today_minutes,
              COALESCE(t.week_min, 0)::int AS week_minutes,
              COALESCE(t.started_today, false) AS started_today,
              t.last_end_hm
       FROM users u
       LEFT JOIN time_entries o ON o.user_id = u.id AND o.end_time IS NULL
       LEFT JOIN LATERAL (
         SELECT SUM(te.duration_minutes) FILTER (WHERE te.end_time IS NOT NULL AND ${entryDay('te')} = $1::date) AS day_min,
                SUM(te.duration_minutes) FILTER (WHERE te.end_time IS NOT NULL) AS week_min,
                bool_or(${entryDay('te')} = $1::date) AS started_today,
                to_char(MAX(${laPazWall('te.end_time')}) FILTER (WHERE ${entryDay('te')} = $1::date), 'HH24:MI') AS last_end_hm
         FROM time_entries te
         WHERE te.user_id = u.id AND ${entryDay('te')} BETWEEN $2::date AND $2::date + 5
       ) t ON true
       ORDER BY u.name`,
      [today, monday]
    );
    const admin = notifier.normalizeBoPhone(notifier.getConfig().phone);
    const workers = r.rows
      .filter((u) => !(admin && notifier.normalizeBoPhone(u.phone) === admin))
      .map((u) => ({
        ...u,
        week_pay_bs: whatsapp.payBs(u.week_minutes, u.hourly_rate)
      }));
    return { today, week_start: monday, workers };
  }

  function statusText(ov) {
    const lines = [`📋 Estado ${ov.today.slice(8, 10)}/${ov.today.slice(5, 7)}`];
    for (const w of ov.workers) {
      if (w.open_entry_id) {
        lines.push(`🟢 ${w.name}: prendido desde ${w.open_day !== ov.today ? `${w.open_day.slice(8, 10)}/${w.open_day.slice(5, 7)} ` : ''}${w.open_start_hm}${w.open_started_by === 'admin' ? ' (admin)' : ''}`);
      } else if (w.started_today) {
        lines.push(`✅ ${w.name}: ${h(w.today_minutes)} hoy (apagó ${w.last_end_hm || '—'})`);
      } else {
        lines.push(`⚪ ${w.name}: sin inicio`);
      }
    }
    return lines.join('\n');
  }

  /** Turnos de hoy por trabajador (para /admin/status). */
  async function todayShifts(today) {
    const r = await pool.query(
      `SELECT te.id, te.user_id, te.started_by, te.stopped_by, te.observation, te.stop_reason,
              te.duration_minutes, (te.end_time IS NULL) AS open,
              to_char(${laPazWall('te.start_time')}, 'HH24:MI') AS start,
              to_char(${laPazWall('te.end_time')}, 'HH24:MI') AS end,
              (${laPazWall('te.end_time')}::date - ${entryDay('te')}) AS end_days
       FROM time_entries te
       WHERE ${entryDay('te')} = $1::date OR te.end_time IS NULL
       ORDER BY te.start_time`,
      [today]
    );
    const by = new Map();
    for (const x of r.rows) {
      if (!by.has(x.user_id)) by.set(x.user_id, []);
      by.get(x.user_id).push({
        entry_id: x.id,
        start: x.start,
        end: x.open ? null : (x.end_days > 0 ? `${x.end} (+${x.end_days}d)` : x.end),
        open: x.open,
        hours: x.open ? null : formatHours(x.duration_minutes).hours,
        started_by: x.started_by || 'worker',
        stopped_by: x.open ? null : (x.stopped_by || 'worker'),
        note: x.observation || null
      });
    }
    return by;
  }

  async function statusPayload() {
    const ov = await workersOverview();
    const shifts = await todayShifts(ov.today);
    const workers = ov.workers.map((w) => {
      const list = shifts.get(w.id) || [];
      return {
        id: w.id,
        name: w.name,
        phone: w.phone,
        state: w.open_entry_id ? 'prendido' : (w.started_today ? 'apagado' : 'sin_inicio'),
        shifts: list,
        today_hours: formatHours(w.today_minutes).hours,
        week_hours: formatHours(w.week_minutes).hours,
        hourly_rate: w.hourly_rate,
        week_pay_bs: w.week_pay_bs
      };
    });
    return { success: true, today: ov.today, week_start: ov.week_start, weak_password: weakPassword, workers, text: statusText(ov) };
  }

  /** 'HH:MM' (o '8', '8:5', '08.30', '8h') de HOY en La Paz → Date. La Paz no tiene horario de verano (UTC-4 fijo). */
  function parseTodayTime(value) {
    if (value == null || value === '') return null;
    const m = /^\s*(\d{1,2})(?:[:.h](\d{1,2}))?\s*h?\s*$/i.exec(String(value));
    if (!m) return NaN;
    const hh = Number(m[1]);
    const mm = Number(m[2] || 0);
    if (hh > 23 || mm > 59) return NaN;
    const today = whatsapp.laPazParts().date;
    return new Date(`${today}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-04:00`);
  }

  /** Resuelve "worker" (nombre aproximado o teléfono) → { worker } | { status, error, candidates? }. */
  async function resolveWorker(q) {
    const ov = await workersOverview();
    const raw = String(q == null ? '' : q).trim();
    if (!raw) return { status: 400, error: 'Falta "worker" (nombre o teléfono)' };
    const canon = notifier.normalizeBoPhone(raw);
    if (canon) {
      const w = ov.workers.find((x) => notifier.normalizeBoPhone(x.phone) === canon);
      return w ? { worker: w } : { status: 404, error: `No hay trabajador con el teléfono ${raw}` };
    }
    if (/^\d+$/.test(raw)) {
      const w = ov.workers.find((x) => String(x.id) === raw);
      if (w) return { worker: w };
    }
    const found = matchWorkers(ov.workers, raw);
    if (found.length === 1) return { worker: found[0] };
    if (!found.length) {
      return { status: 404, error: `No encontré a "${raw}"`, candidates: ov.workers.map((w) => w.name) };
    }
    return { status: 409, error: `"${raw}" coincide con varios`, candidates: found.map((w) => w.name) };
  }

  async function shiftAction(kind, req, res) {
    const { worker, time, note, latitude, longitude } = req.body || {};
    try {
      const at = parseTodayTime(time);
      if (Number.isNaN(at)) return res.status(400).json({ success: false, error: 'time debe ser HH:MM (hora La Paz de hoy)' });
      const rw = await resolveWorker(worker);
      if (!rw.worker) return res.status(rw.status).json({ success: false, error: rw.error, candidates: rw.candidates });
      const w = rw.worker;
      const r = kind === 'start'
        ? await startShift(w.id, { by: 'admin', at: at || undefined, note, latitude, longitude })
        : await stopShift({ userId: w.id }, { by: 'admin', at: at || undefined, observation: note, latitude, longitude });
      if (!r.ok) return res.status(r.status).json({ success: false, worker: w.name, error: r.error });
      let totals = null;
      if (kind === 'stop') {
        // Totales del día en que EMPEZÓ el turno (puede ser ayer si pasó la medianoche)
        const d = await pool.query(`SELECT ${entryDay('te')}::text AS day FROM time_entries te WHERE te.id = $1`, [r.entry_id]);
        totals = await whatsapp.workerTotals(w.id, d.rows[0].day);
      }
      const startedAt = kind === 'start' ? whatsapp.hhmm(r.startAt) : null;
      res.json({
        success: true,
        worker: w.name,
        action: kind,
        entry_id: r.entry_id,
        ...(kind === 'start'
          ? { start: startedAt, message: `🟢 ${w.name}: inicio registrado ${startedAt}` }
          : {
            end: whatsapp.hhmm(at || new Date()),
            duration_hours: r.duration_hours,
            today_hours: formatHours(totals.day_min).hours,
            week_hours: formatHours(totals.week_min).hours,
            message: `🔴 ${w.name}: fin registrado ${whatsapp.hhmm(at || new Date())} — ${r.duration_hours} h`
          })
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }

  app.post('/admin/shift/start', requireAdmin, (req, res) => shiftAction('start', req, res));
  app.post('/admin/shift/stop', requireAdmin, (req, res) => shiftAction('stop', req, res));
  const statusHandler = async (req, res) => {
    try {
      res.json(await statusPayload());
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  };
  app.get('/admin/status', requireAdmin, statusHandler);
  app.post('/admin/status', requireAdmin, statusHandler);

  // ---------- Pantalla ----------
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

  // ---------- API ----------
  app.post('/admin/api/login', requireAdmin, (req, res) => {
    res.json({ success: true, weak_password: weakPassword, whatsapp: notifier.status() });
  });

  app.get('/admin/api/workers', requireAdmin, async (req, res) => {
    try {
      res.json({ success: true, weak_password: weakPassword, ...(await workersOverview()) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Alta / actualización de trabajador. Body: { name, phone, hourly_rate? } */
  app.post('/admin/api/workers', requireAdmin, async (req, res) => {
    try {
      const { user, created } = await upsertWorker(req.body || {});
      res.status(created ? 201 : 200).json({ success: true, created, user });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  /** Tarifa por hora (Bs). Body: { hourly_rate: number|null } */
  app.post('/admin/api/workers/:id/rate', requireAdmin, async (req, res) => {
    const raw = req.body ? req.body.hourly_rate : null;
    const rate = raw == null || raw === '' ? null : Number(raw);
    if (rate != null && (!Number.isFinite(rate) || rate < 0)) {
      return res.status(400).json({ error: 'Tarifa inválida' });
    }
    try {
      const r = await pool.query(
        'UPDATE users SET hourly_rate = $1 WHERE id = $2 RETURNING id, name, hourly_rate::float AS hourly_rate',
        [rate, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
      res.json({ success: true, user: r.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Prender. Body: { user_id } | { all: true } (todos los que no iniciaron hoy); latitude/longitude opcionales. */
  app.post('/admin/api/start', requireAdmin, async (req, res) => {
    const { user_id, all, latitude, longitude } = req.body || {};
    try {
      if (all) {
        const targets = await whatsapp.findStartReminderTargets(whatsapp.laPazParts().date);
        const results = [];
        for (const t of targets) {
          const r = await startShift(t.id, { by: 'admin', latitude, longitude });
          results.push({ user_id: t.id, name: t.name, ok: r.ok, error: r.error });
        }
        return res.json({ success: true, results });
      }
      if (!user_id) return res.status(400).json({ error: 'user_id o all requerido' });
      const r = await startShift(user_id, { by: 'admin', latitude, longitude });
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      res.json({ success: true, entry_id: r.entry_id, start_time: r.start_time });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Apagar. Body: { user_id } | { all: true } (todos los turnos abiertos); latitude/longitude opcionales. */
  app.post('/admin/api/stop', requireAdmin, async (req, res) => {
    const { user_id, all, latitude, longitude, observation } = req.body || {};
    try {
      if (all) {
        const open = await pool.query(
          `SELECT te.user_id, u.name FROM time_entries te JOIN users u ON u.id = te.user_id
           WHERE te.end_time IS NULL ORDER BY u.name`
        );
        const results = [];
        for (const o of open.rows) {
          const r = await stopShift({ userId: o.user_id }, { by: 'admin', latitude, longitude, observation });
          results.push({ user_id: o.user_id, name: o.name, ok: r.ok, duration_hours: r.duration_hours, error: r.error });
        }
        return res.json({ success: true, results });
      }
      if (!user_id) return res.status(400).json({ error: 'user_id o all requerido' });
      const r = await stopShift({ userId: user_id }, { by: 'admin', latitude, longitude, observation });
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      res.json({ success: true, duration_hours: r.duration_hours, duration_minutes: r.duration_minutes, entry_id: r.entry_id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Vista previa de resúmenes desde el panel. Body: { kind, date? } */
  app.post('/admin/api/summary', requireAdmin, async (req, res) => {
    const kind = req.body && req.body.kind === 'weekly' ? 'weekly' : 'daily';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String((req.body && req.body.date) || ''))
      ? req.body.date : whatsapp.laPazParts().date;
    try {
      const text = kind === 'weekly'
        ? await whatsapp.buildWeeklySummary(whatsapp.mondayOf(date))
        : await whatsapp.buildDailySummary(date);
      res.json({ success: true, kind, date, text });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- Comandos por WhatsApp (webhook Evolution) ----------
  const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  /** Busca trabajadores por nombre (sin tildes; exacto, luego prefijo, luego contiene). */
  function matchWorkers(workers, q) {
    const f = fold(q);
    if (!f) return [];
    const exact = workers.filter((w) => fold(w.name) === f);
    if (exact.length) return exact;
    const first = workers.filter((w) => fold(w.name).split(/\s+/)[0] === f);
    if (first.length) return first;
    const prefix = workers.filter((w) => fold(w.name).startsWith(f));
    if (prefix.length) return prefix;
    return workers.filter((w) => fold(w.name).includes(f));
  }

  const HELP = 'Comandos: "inicio <nombre>", "inicio todos", "fin <nombre>", "fin todos", "estado".';

  /** Ejecuta un comando del admin. Devuelve el texto de respuesta o null si no es un comando. */
  async function runCommand(text) {
    const m = /^\s*(inicio|iniciar|prender|fin|finalizar|apagar|estado|ayuda)\b\s*(.*)$/i.exec(fold(text));
    if (!m) return null;
    const verb = m[1];
    const arg = m[2].trim();
    if (verb === 'ayuda') return HELP;
    const ov = await workersOverview();
    if (verb === 'estado') return statusText(ov);

    const isStart = ['inicio', 'iniciar', 'prender'].includes(verb);
    if (!arg) return `Falta el nombre. ${HELP}`;
    // Hora opcional al final: "inicio jimi 8:30" / "fin leo a las 17"
    let name = arg;
    let at;
    const tm = /^(.*?)\s+(?:a las\s+)?(\d{1,2}(?:[:.h]\d{2})?)\s*h?$/.exec(arg);
    if (tm) {
      const parsed = parseTodayTime(tm[2]);
      if (Number.isNaN(parsed)) return `Hora inválida: ${tm[2]}`;
      name = tm[1].trim();
      at = parsed;
    }

    let targets;
    if (name === 'todos') {
      targets = isStart
        ? (await whatsapp.findStartReminderTargets(ov.today)).map((t) => ov.workers.find((w) => w.id === t.id) || t)
        : ov.workers.filter((w) => w.open_entry_id);
      if (!targets.length) return isStart ? 'No falta nadie: todos iniciaron hoy.' : 'No hay turnos abiertos.';
    } else {
      targets = matchWorkers(ov.workers, name);
      if (!targets.length) return `No encontré a "${name}". Trabajadores: ${ov.workers.map((w) => w.name).join(', ')}`;
      if (targets.length > 1) return `"${name}" coincide con varios: ${targets.map((w) => w.name).join(', ')}. Escribí el nombre completo.`;
    }

    const out = [];
    for (const w of targets) {
      if (isStart) {
        const r = await startShift(w.id, { by: 'admin', at });
        out.push(r.ok
          ? `🟢 ${w.name}: inicio ${whatsapp.hhmm(r.startAt)}`
          : `⚠️ ${w.name}: ${r.error}`);
      } else {
        const r = await stopShift({ userId: w.id }, { by: 'admin', at });
        out.push(r.ok ? `🔴 ${w.name}: fin — ${r.duration_hours} h` : `⚠️ ${w.name}: ${r.error}`);
      }
    }
    return out.join('\n');
  }

  /** Texto + remitentes posibles de un evento messages.upsert de Evolution v2. */
  function parseEvolutionMessage(body) {
    const event = String(body && body.event || '').toLowerCase().replace(/_/g, '.');
    if (event && event !== 'messages.upsert') return null;
    const data = Array.isArray(body.data) ? body.data[0] : (body.data || {});
    const key = data.key || {};
    if (key.fromMe) return null;
    const msg = data.message || {};
    const text = msg.conversation
      || (msg.extendedTextMessage && msg.extendedTextMessage.text)
      || (msg.ephemeralMessage && msg.ephemeralMessage.message
        && (msg.ephemeralMessage.message.conversation
          || (msg.ephemeralMessage.message.extendedTextMessage || {}).text))
      || '';
    if (!text) return null;
    // remoteJid puede venir como @lid; probar también los campos alternativos
    const senders = [key.remoteJid, key.remoteJidAlt, key.senderPn, key.participant, data.sender, body.sender]
      .filter(Boolean)
      .map((j) => String(j).split('@')[0].split(':')[0].replace(/\D/g, ''));
    const isGroup = String(key.remoteJid || '').endsWith('@g.us');
    return { id: key.id || null, text: String(text), senders, isGroup };
  }

  app.post('/webhook/evolution', async (req, res) => {
    const expected = String(process.env.EVOLUTION_WEBHOOK_TOKEN || '').trim();
    if (!expected) return res.status(404).json({ error: 'webhook deshabilitado' });
    const token = String(req.query.token || '');
    if (!token || !safeEqual(token, expected)) return res.status(401).json({ error: 'token inválido' });
    // Responder rápido siempre (Evolution reintenta si tarda); procesar después
    res.json({ ok: true });

    try {
      const m = parseEvolutionMessage(req.body || {});
      if (!m || m.isGroup) return;
      const admin = notifier.normalizeBoPhone(notifier.getConfig().phone);
      if (!admin || !m.senders.some((s) => notifier.normalizeBoPhone(s) === admin)) return;
      if (!/^\s*(inicio|iniciar|prender|fin|finalizar|apagar|estado|ayuda)\b/i.test(fold(m.text))) return;
      // Dedup por id de mensaje (Evolution puede reenviar el mismo evento)
      if (m.id) {
        const r = await pool.query(
          `INSERT INTO notification_log (kind, ref_date, status, attempts, claimed_at)
           VALUES ($1, (NOW() AT TIME ZONE 'America/La_Paz')::date, 'sent', 1, NOW())
           ON CONFLICT (kind, ref_date) DO NOTHING RETURNING id`,
          [`wa_cmd:${String(m.id).slice(0, 100)}`]
        );
        if (!r.rows.length) return;
      }
      const reply = await runCommand(m.text);
      if (!reply) return;
      // Los inicios/fines exitosos ya llegan como alerta en tiempo real ("🟢 X prendió… (por el admin)"):
      // para inicio/fin solo se responden los errores; estado/ayuda se responden completos.
      const isAction = /^\s*(inicio|iniciar|prender|fin|finalizar|apagar)\b/i.test(fold(m.text));
      const text = isAction
        ? reply.split('\n').filter((l) => !/^(🟢|🔴)/u.test(l)).join('\n')
        : reply;
      if (text.trim()) notifier.notify(text, { tag: 'admin_cmd' });
    } catch (e) {
      console.error('[admin] webhook:', e.message);
    }
  });

  return { requireAdmin, checkAdmin, workersOverview, runCommand, statusText, weakPassword, parseTodayTime, resolveWorker };
}

module.exports = { registerAdmin };
