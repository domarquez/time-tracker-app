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
  pool, whatsapp, notifier, startShift, stopShift, upsertWorker, formatHours,
  roundingDetail, getWeekStartLaPaz
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
      `SELECT u.id, u.name, u.phone, u.hourly_rate::float AS hourly_rate, u.is_admin,
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
      .filter((u) => !u.is_admin && !(admin && notifier.normalizeBoPhone(u.phone) === admin))
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

  // ---------- Corregir / borrar un turno ----------
  /** 'HH:MM' (mismos formatos que time) del día `dateStr` (YYYY-MM-DD) en La Paz → Date | NaN. */
  function parseDayTime(dateStr, value) {
    const m = /^\s*(\d{1,2})(?:[:.h](\d{1,2}))?\s*h?\s*$/i.exec(String(value));
    if (!m) return new Date(NaN);
    const hh = Number(m[1]);
    const mm = Number(m[2] || 0);
    if (hh > 23 || mm > 59) return new Date(NaN);
    return new Date(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-04:00`);
  }
  const given = (v) => v != null && String(v).trim() !== '';

  /**
   * POST /admin/shift/edit { password, entry_id, start?: 'HH:MM', end?: 'HH:MM', delete?: true, note? }
   * Horas en La Paz del día del turno; si end <= start se toma como el día siguiente
   * (turno pasada la medianoche). Recalcula duration_minutes con el mismo redondeo
   * y ajusta weekly_summaries. Poner `end` a un turno abierto lo cierra (stopped_by admin).
   */
  app.post('/admin/shift/edit', requireAdmin, async (req, res) => {
    const { entry_id, start, end, note } = req.body || {};
    const del = req.body && (req.body.delete === true || req.body.delete === 'true');
    const id = Number(entry_id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'entry_id requerido (número)' });
    }
    if (!del && !given(start) && !given(end)) {
      return res.status(400).json({ success: false, error: 'Mandá start y/o end (HH:MM, hora La Paz) o delete: true' });
    }
    const client = await pool.connect();
    const fail = async (status, error) => {
      await client.query('ROLLBACK');
      return res.status(status).json({ success: false, error });
    };
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT te.id, te.user_id, u.name, te.start_time, te.end_time, te.duration_minutes,
                ${entryDay('te')}::text AS day
         FROM time_entries te JOIN users u ON u.id = te.user_id
         WHERE te.id = $1 FOR UPDATE OF te`,
        [id]
      );
      if (!r.rows.length) return await fail(404, `No existe el turno ${id}`);
      const e = r.rows[0];
      const oldStart = new Date(e.start_time);
      const oldEnd = e.end_time ? new Date(e.end_time) : null;
      const oldMin = oldEnd ? Number(e.duration_minutes) || 0 : 0;
      const before = {
        start: whatsapp.hhmm(oldStart),
        end: oldEnd ? whatsapp.hhmm(oldEnd) : null,
        duration_hours: oldEnd ? formatHours(oldMin).hours : null
      };
      const weekOld = await getWeekStartLaPaz(oldStart.toISOString());
      const weekAdd = async (week, minutes) => {
        if (!minutes) return;
        const u = await client.query(
          `UPDATE weekly_summaries SET total_minutes = GREATEST(0, total_minutes + $1)
           WHERE user_id = $2 AND week_start = $3`,
          [minutes, e.user_id, week]
        );
        if (!u.rowCount && minutes > 0) {
          await client.query(
            'INSERT INTO weekly_summaries (user_id, week_start, total_minutes) VALUES ($1, $2, $3)',
            [e.user_id, week, minutes]
          );
        }
      };

      if (del) {
        await client.query('DELETE FROM time_entries WHERE id = $1', [id]);
        await weekAdd(weekOld, -oldMin);
        await client.query('COMMIT');
        console.log(`[admin] turno ${id} de ${e.name} (${e.day} ${before.start}–${before.end || 'abierto'}) borrado`);
        return res.json({ success: true, deleted: true, entry_id: id, worker: e.name, day: e.day, before });
      }

      const newStart = given(start) ? parseDayTime(e.day, start) : oldStart;
      if (Number.isNaN(newStart.getTime())) return await fail(400, 'start debe ser HH:MM (hora La Paz)');
      let newEnd = oldEnd;
      if (given(end)) {
        newEnd = parseDayTime(e.day, end);
        if (Number.isNaN(newEnd.getTime())) return await fail(400, 'end debe ser HH:MM (hora La Paz)');
        if (newEnd <= newStart) newEnd = new Date(newEnd.getTime() + 24 * 3600 * 1000); // pasó la medianoche
      }
      const now = Date.now();
      if (newStart.getTime() > now + 60000) return await fail(400, 'El inicio no puede ser futuro');
      if (newEnd && newEnd.getTime() > now + 60000) return await fail(400, 'El fin no puede ser futuro');
      if (newEnd && newEnd <= newStart) return await fail(400, 'end debe ser posterior a start');
      if (newEnd && newEnd - newStart > 24 * 3600 * 1000) return await fail(400, 'El turno no puede durar más de 24 h');

      const overlap = await client.query(
        `SELECT id, to_char(${laPazWall('start_time')}, 'HH24:MI') AS s, to_char(${laPazWall('end_time')}, 'HH24:MI') AS e
         FROM time_entries
         WHERE user_id = $1 AND id <> $2 AND start_time < $4 AND COALESCE(end_time, 'infinity') > $3
         LIMIT 1`,
        [e.user_id, id, newStart.toISOString(), newEnd ? newEnd.toISOString() : 'infinity']
      );
      if (overlap.rows.length) {
        const o = overlap.rows[0];
        return await fail(409, `Se superpone con el turno ${o.id} (${o.s}–${o.e || 'abierto'})`);
      }

      const minutes = newEnd ? roundingDetail(Math.floor((newEnd - newStart) / 60000)).rounded : null;
      const closing = !oldEnd && !!newEnd;
      const obs = `Editado por admin (antes ${before.start}–${before.end || 'abierto'})${given(note) ? `: ${String(note).trim()}` : ''}`;
      await client.query(
        `UPDATE time_entries
         SET start_time = $2, end_time = $3, duration_minutes = $4,
             observation = concat_ws(' · ', NULLIF(observation, ''), $5::text),
             stopped_by = CASE WHEN $6 THEN 'admin' ELSE stopped_by END,
             stop_reason = CASE WHEN $6 THEN 'admin' ELSE stop_reason END,
             night_ask_at = CASE WHEN $6 THEN NULL ELSE night_ask_at END,
             night_ask_phase = CASE WHEN $6 THEN NULL ELSE night_ask_phase END
         WHERE id = $1`,
        [id, newStart.toISOString(), newEnd ? newEnd.toISOString() : null, minutes, obs, closing]
      );
      const weekNew = await getWeekStartLaPaz(newStart.toISOString());
      await weekAdd(weekOld, -oldMin);
      await weekAdd(weekNew, minutes || 0);
      await client.query('COMMIT');
      const after = {
        start: whatsapp.hhmm(newStart),
        end: newEnd ? whatsapp.hhmm(newEnd) : null,
        duration_hours: newEnd ? formatHours(minutes).hours : null
      };
      console.log(`[admin] turno ${id} de ${e.name} editado: ${before.start}–${before.end || 'abierto'} → ${after.start}–${after.end || 'abierto'}`);
      res.json({
        success: true, entry_id: id, worker: e.name, day: e.day, before, after,
        duration_minutes: minutes,
        message: `✏️ ${e.name} ${e.day}: ${after.start}–${after.end || 'abierto'}${newEnd ? ` (${after.duration_hours} h)` : ''}`
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  });

  const statusHandler = async (req, res) => {
    try {
      res.json(await statusPayload());
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  };
  app.get('/admin/status', requireAdmin, statusHandler);
  app.post('/admin/status', requireAdmin, statusHandler);

  // ---------- Unificar / borrar usuarios ----------
  /**
   * Resuelve un usuario por id o por nombre EXACTO (sensible a mayúsculas; si no hay
   * exacto, acepta un único match sin mayúsculas/tildes). Usa el client de la transacción.
   */
  async function resolveUserStrict(db, ref) {
    if (ref == null || ref === '') throw Object.assign(new Error('Usuario vacío'), { status: 400 });
    if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
      const r = await db.query('SELECT id, name, phone, is_admin FROM users WHERE id = $1', [Number(ref)]);
      if (!r.rows.length) throw Object.assign(new Error(`No existe el usuario id ${ref}`), { status: 404 });
      return r.rows[0];
    }
    const name = String(ref);
    const exact = await db.query('SELECT id, name, phone, is_admin FROM users WHERE name = $1', [name]);
    if (exact.rows.length === 1) return exact.rows[0];
    const all = await db.query('SELECT id, name, phone, is_admin FROM users');
    const f = fold(name);
    const loose = all.rows.filter((u) => fold(u.name) === f);
    if (loose.length === 1) return loose[0];
    if (!loose.length) throw Object.assign(new Error(`No existe el usuario "${name}"`), { status: 404 });
    throw Object.assign(new Error(`"${name}" es ambiguo (${loose.map((u) => `${u.id}:${u.name}`).join(', ')}); usá el id`), { status: 409 });
  }

  /**
   * POST /admin/users/merge { password, keep, remove: [...], rename?, mark_admin? (default true) }
   * En una transacción: pasa los turnos y resúmenes semanales de los usuarios `remove` al
   * usuario `keep`, deja como mucho un turno abierto, borra las marcas de notificación por
   * usuario de los eliminados, borra los usuarios y marca `keep` como admin.
   */
  app.post('/admin/users/merge', requireAdmin, async (req, res) => {
    const { keep, remove, rename } = req.body || {};
    const markAdmin = !(req.body && (req.body.mark_admin === false || req.body.mark_admin === 'false'));
    const list = Array.isArray(remove) ? remove : (remove != null ? [remove] : []);
    if (keep == null || !list.length) return res.status(400).json({ success: false, error: 'keep y remove[] son obligatorios' });
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const kept = await resolveUserStrict(db, keep);
      const removed = [];
      for (const ref of list) {
        const u = await resolveUserStrict(db, ref);
        if (u.id === kept.id) throw Object.assign(new Error(`"${ref}" es el mismo usuario que keep`), { status: 400 });
        if (!removed.some((x) => x.id === u.id)) removed.push(u);
      }
      const ids = removed.map((u) => u.id);
      await db.query('SELECT id FROM users WHERE id = ANY($1::int[]) OR id = $2 FOR UPDATE', [ids, kept.id]);

      // Un solo turno abierto por usuario: si quedarían varios, se cierran los sobrantes en 0 min
      const open = await db.query(
        `SELECT id, user_id FROM time_entries WHERE end_time IS NULL AND (user_id = ANY($1::int[]) OR user_id = $2)
         ORDER BY (user_id = $2) DESC, start_time DESC`,
        [ids, kept.id]
      );
      const toClose = open.rows.slice(1).map((r) => r.id);
      if (toClose.length) {
        await db.query(
          `UPDATE time_entries SET end_time = start_time, duration_minutes = 0, stop_reason = 'unificado',
                  observation = COALESCE(observation, 'Cerrado al unificar usuarios'), stopped_by = 'admin',
                  night_ask_at = NULL, night_ask_phase = NULL
           WHERE id = ANY($1::int[])`,
          [toClose]
        );
      }
      const moved = await db.query('UPDATE time_entries SET user_id = $1 WHERE user_id = ANY($2::int[])', [kept.id, ids]);
      await db.query('UPDATE weekly_summaries SET user_id = $1 WHERE user_id = ANY($2::int[])', [kept.id, ids]);
      // Colapsar semanas duplicadas del usuario conservado
      await db.query(
        `WITH agg AS (
           SELECT week_start, MIN(id) AS keep_id, SUM(total_minutes) AS total
           FROM weekly_summaries WHERE user_id = $1 GROUP BY week_start HAVING COUNT(*) > 1
         ), upd AS (
           UPDATE weekly_summaries w SET total_minutes = agg.total FROM agg WHERE w.id = agg.keep_id RETURNING w.id
         )
         DELETE FROM weekly_summaries w USING agg
         WHERE w.user_id = $1 AND w.week_start = agg.week_start AND w.id <> agg.keep_id`,
        [kept.id]
      );
      // Marcas de notificación por usuario (recordatorios / semanal) de los eliminados
      const kinds = ids.flatMap((id) => [`worker_start_reminder:${id}:%`, `worker_weekly:${id}`]);
      const notif = await db.query('DELETE FROM notification_log WHERE kind LIKE ANY($1::text[])', [kinds]);
      const del = await db.query('DELETE FROM users WHERE id = ANY($1::int[]) RETURNING id, name, phone', [ids]);

      // Datos del conservado: teléfono del admin si no tenía, nombre nuevo opcional, is_admin
      if (markAdmin) {
        let phoneUpdate = null;
        if (!kept.phone) {
          const canon = notifier.normalizeBoPhone(notifier.getConfig().phone);
          const taken = canon ? await db.query(
            'SELECT 1 FROM users WHERE phone = ANY($1::text[])', [[`+${canon}`, canon, canon.slice(3)]]
          ) : { rows: [1] };
          if (canon && !taken.rows.length) phoneUpdate = `+${canon}`;
        }
        await db.query('UPDATE users SET is_admin = true, phone = COALESCE($2, phone) WHERE id = $1', [kept.id, phoneUpdate]);
      }
      if (rename && String(rename).trim()) {
        await db.query('UPDATE users SET name = $1 WHERE id = $2', [String(rename).trim(), kept.id]);
      }
      const final = await db.query('SELECT id, name, phone, is_admin FROM users WHERE id = $1', [kept.id]);
      await db.query('COMMIT');
      console.log(`[admin] unificados ${ids.join(',')} → ${kept.id}`);
      res.json({
        success: true,
        kept: final.rows[0],
        removed: del.rows,
        entries_moved: moved.rowCount,
        open_entries_closed: toClose.length,
        notification_marks_deleted: notif.rowCount
      });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      res.status(e.status || 500).json({ success: false, error: e.code === '23505' ? `Conflicto de datos únicos: ${e.detail || e.message}` : e.message });
    } finally {
      db.release();
    }
  });

  /**
   * POST /admin/users/delete { password, user, force? }
   * Borra un usuario. Si tiene turnos, exige force: true y borra también sus turnos y
   * resúmenes semanales (para no perder por error el historial de un trabajador).
   */
  app.post('/admin/users/delete', requireAdmin, async (req, res) => {
    const { user, force } = req.body || {};
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const u = await resolveUserStrict(db, user);
      const cnt = await db.query('SELECT COUNT(*)::int AS n FROM time_entries WHERE user_id = $1', [u.id]);
      if (cnt.rows[0].n > 0 && !(force === true || force === 'true')) {
        throw Object.assign(new Error(`${u.name} tiene ${cnt.rows[0].n} turnos; mandá force: true para borrarlos también (o usá /admin/users/merge)`), { status: 409 });
      }
      const te = await db.query('DELETE FROM time_entries WHERE user_id = $1', [u.id]);
      await db.query('DELETE FROM weekly_summaries WHERE user_id = $1', [u.id]);
      await db.query('DELETE FROM notification_log WHERE kind LIKE ANY($1::text[])',
        [[`worker_start_reminder:${u.id}:%`, `worker_weekly:${u.id}`]]);
      await db.query('DELETE FROM users WHERE id = $1', [u.id]);
      await db.query('COMMIT');
      console.log(`[admin] usuario ${u.id} (${u.name}) borrado`);
      res.json({ success: true, deleted: { id: u.id, name: u.name, phone: u.phone }, entries_deleted: te.rowCount });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      res.status(e.status || 500).json({ success: false, error: e.message });
    } finally {
      db.release();
    }
  });

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
