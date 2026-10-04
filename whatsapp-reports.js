/**
 * Alertas en tiempo real + resúmenes programados por WhatsApp al admin.
 * Usa notifier.js (proveedor intercambiable) y persiste marcas de envío en
 * notification_log(kind, ref_date) para no duplicar ni perder envíos tras
 * reinicios/redeploys.
 *
 * Horarios (America/La_Paz):
 *  - Aviso "sigue prendido": todos los días desde LEFT_ON_ALERT_TIME (default 20:00),
 *    una vez por turno abierto y por día (notification_log kind 'left_on:<entry_id>')
 *  - Recordatorio de inicio al trabajador: lunes a sábado, START_REMINDER_TIMES
 *    (default 08:00,10:00,12:00), solo si ese día todavía no prendió
 *  - Resumen diario:  lunes a sábado, DAILY_SUMMARY_TIME  (default 21:30)
 *  - Resumen semanal: sábado,         WEEKLY_SUMMARY_TIME (default 21:45)
 * Si el servidor estuvo caído a esa hora, se envía en cuanto vuelve
 * (mientras sea el mismo día en La Paz).
 */
const notifier = require('./notifier');
const { laPazWall, entryDay } = require('./tz-sql');

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const WEEKDAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MAX_ATTEMPTS = 3;
const MAX_OBS_LINES = 10;
const MAX_SEGMENTS = 6; // tramos por trabajador en el diario
const DEFAULT_APP_URL = 'https://time-tracker-app-production-2a17.up.railway.app';
const appUrl = () => String(process.env.APP_URL || DEFAULT_APP_URL).trim().replace(/\/+$/, '');

function parseHHMM(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return h * 60 + mi;
}

function createWhatsappReports({ pool, TZ, formatHours }) {
  const partsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  });

  /** { date: 'YYYY-MM-DD', hour, minute, weekday (0=dom) } en La Paz */
  function laPazParts(d = new Date()) {
    const p = {};
    for (const { type, value } of partsFmt.formatToParts(new Date(d))) p[type] = value;
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      hour: Number(p.hour) % 24,
      minute: Number(p.minute),
      weekday: WEEKDAY_IDX[p.weekday]
    };
  }

  function hhmm(d) {
    const p = laPazParts(d);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }

  /** 'YYYY-MM-DD' ± días (aritmética en UTC, sin efectos de zona) */
  function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function weekdayOf(dateStr) {
    return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  }

  function ddmm(dateStr) {
    const s = String(dateStr).slice(0, 10);
    return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  }

  const h = (minutes) => `${formatHours(minutes).hours} h`;

  /** Motivo legible a partir de observation / stop_reason. */
  function motivoCorte(observation, stopReason) {
    let m = String(observation || '').trim()
      .replace(/^corte autom[aá]tico\s*:?\s*/i, '')
      .replace(/^a\s+(medianoche)/i, '$1')
      .trim();
    if (!m) {
      if (stopReason === 'medianoche') m = 'medianoche';
      else if (stopReason === 'sin_respuesta_noche') m = 'sin respuesta';
      else m = stopReason || 'auto';
    }
    return m;
  }

  async function userName(userId) {
    const r = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    return r.rows.length ? r.rows[0].name : `Usuario ${userId}`;
  }

  /** Nunca bloquea ni lanza: ejecuta en segundo plano y loguea errores. */
  function background(tag, fn) {
    setImmediate(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => console.error(`[whatsapp] ${tag}:`, e.message));
    });
  }

  function realtimeEnabled() {
    const v = process.env.WHATSAPP_REALTIME_ENABLED;
    return v == null || v === '' || !/^(0|false|no|off)$/i.test(v.trim());
  }

  // ---------- Alertas en tiempo real ----------
  function alertStart(userId, at = new Date()) {
    if (!realtimeEnabled()) return;
    background('alertStart', async () => {
      const name = await userName(userId);
      await notifier.notify(`🟢 *${name}* prendió a las ${hhmm(at)}`, { tag: 'start' });
    });
  }

  function alertStop(userId, minutes, at = new Date()) {
    if (!realtimeEnabled()) return;
    background('alertStop', async () => {
      const name = await userName(userId);
      await notifier.notify(`🔴 *${name}* apagó a las ${hhmm(at)} — ${h(minutes)}`, { tag: 'stop' });
    });
  }

  // ---------- Avisos de turno (admin + trabajador), con dedup en notification_log ----------
  /** Envía una sola vez por (kind, refDate). No hace nada si WhatsApp está deshabilitado. */
  async function sendOnce(kind, refDate, text, opts = {}) {
    if (!notifier.getConfig().enabled) return false;
    if (!(await claim(kind, refDate))) return false;
    const result = await notifier.notify(text, { tag: `${kind}:${refDate}`, ...opts });
    await markResult(kind, refDate, result.skipped ? { ok: true } : result);
    return result.ok;
  }

  /** Datos del turno para armar mensajes (horas en La Paz). */
  async function entryInfo(entryId) {
    const r = await pool.query(
      `SELECT te.id, te.user_id, u.name, u.phone,
              ${entryDay('te')}::text AS day,
              to_char(${laPazWall('te.start_time')}, 'HH24:MI') AS start_hm,
              to_char(${laPazWall('te.end_time')}, 'HH24:MI') AS end_hm
       FROM time_entries te JOIN users u ON u.id = te.user_id
       WHERE te.id = $1`,
      [entryId]
    );
    return r.rows[0] || null;
  }

  const workerPromptText = (e) =>
    `⏰ Tu turno sigue prendido desde ${e.start_hm}. Abrí la app y confirmá si seguís trabajando o apagá: ${appUrl()}`;

  /** Pregunta de continuar (20:00, 23:00, cada hora…): aviso al trabajador. */
  function alertAsk(entryId, phase) {
    if (!realtimeEnabled()) return;
    background('alertAsk', async () => {
      const e = await entryInfo(entryId);
      if (!e || !e.phone) return;
      await sendOnce(`worker_ask:${e.id}:${phase}`, e.day, workerPromptText(e), { to: e.phone });
    });
  }

  /** El trabajador tocó "Seguir": aviso al admin (uno por pregunta). */
  function alertContinue(entryId, phase, at = new Date()) {
    if (!realtimeEnabled()) return;
    background('alertContinue', async () => {
      const e = await entryInfo(entryId);
      if (!e) return;
      await sendOnce(
        `continue:${e.id}:${phase}`,
        e.day,
        `🔁 *${e.name}* confirmó que sigue trabajando (${hhmm(at)}, desde ${e.start_hm})`
      );
    });
  }

  /**
   * Corte automático: aviso al admin y al trabajador (uno por turno).
   * entryId opcional por compatibilidad (sin él solo va el aviso al admin, sin dedup).
   */
  function alertAutoCut(userId, { observation, stop_reason, minutes, entryId, endAt } = {}) {
    if (!realtimeEnabled()) return;
    background('alertAutoCut', async () => {
      const extra = minutes != null ? ` — ${h(minutes)}` : '';
      const e = entryId ? await entryInfo(entryId) : null;
      const name = e ? e.name : await userName(userId);
      const desde = e ? `, desde ${e.start_hm}` : '';
      const adminText = `⚠️ *${name}*: corte automático (${motivoCorte(observation, stop_reason)}${desde})${extra}`;
      if (!e) {
        await notifier.notify(adminText, { tag: 'autocut' });
        return;
      }
      await sendOnce(`autocut:${e.id}`, e.day, adminText);
      if (e.phone) {
        const at = endAt ? hhmm(endAt) : (e.end_hm || hhmm(new Date()));
        const porque = stop_reason === 'tope_turno'
          ? `por llegar al ${motivoCorte(observation, stop_reason)}`
          : 'por falta de confirmación';
        await sendOnce(
          `worker_autocut:${e.id}`,
          e.day,
          `Tu turno se apagó automáticamente a las ${at} ${porque}. Se acreditaron ${h(minutes || 0)}. ${appUrl()}`,
          { to: e.phone }
        );
      }
    });
  }

  // ---------- Resúmenes ----------
  /** El admin no es trabajador: no aparece en "Sin registro" / "Sin horas". */
  const isAdminPhone = (phone) => {
    const p = notifier.normalizeBoPhone(phone);
    return !!p && p === notifier.normalizeBoPhone(notifier.getConfig().phone);
  };
  const isAutoCut = (r) => ['medianoche', 'sin_respuesta_noche', 'auto', 'tope_turno'].includes(r.stop_reason)
    || /^corte autom[aá]tico/i.test(String(r.observation || '').trim());

  /** Hora de salida; si terminó otro día: '02:10 (+1 día)' (00:00 exacto del día siguiente → '24:00'). */
  function endLabel(endHm, endDays) {
    const d = Number(endDays) || 0;
    if (d === 1 && endHm === '00:00') return '24:00';
    if (d <= 0) return endHm;
    return `${endHm} (+${d} ${d === 1 ? 'día' : 'días'})`;
  }

  /**
   * Resumen diario para dateStr (YYYY-MM-DD, La Paz): entradas/salidas por trabajador.
   * Cada turno cuenta entero para el día en que EMPEZÓ (aunque pase la medianoche).
   */
  async function buildDailySummary(dateStr) {
    const prevDay = addDays(dateStr, -1);
    const [users, entries, open, lateness] = await Promise.all([
      pool.query(`SELECT id, name, phone FROM users WHERE phone IS NOT NULL ORDER BY name`),
      pool.query(
        `SELECT te.id, te.user_id, u.name, te.duration_minutes, te.stop_reason, te.observation,
                (te.end_time IS NULL) AS is_open,
                to_char(${laPazWall('te.start_time')}, 'HH24:MI') AS start_hm,
                to_char(${laPazWall('te.end_time')}, 'HH24:MI') AS end_hm,
                (${laPazWall('te.end_time')}::date - $1::date) AS end_days
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         WHERE ${entryDay('te')} = $1::date
           AND NOT (te.end_time IS NOT NULL AND te.end_time = te.start_time AND COALESCE(te.duration_minutes, 0) = 0)
         ORDER BY u.name, te.start_time`,
        [dateStr]
      ),
      pool.query(
        `SELECT u.name,
                ${entryDay('te')}::text AS day,
                to_char(${laPazWall('te.start_time')}, 'HH24:MI') AS start_hm
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         WHERE te.end_time IS NULL
         ORDER BY u.name`
      ),
      // Turnos del día anterior que terminaron después de medianoche (cuentan para ayer)
      pool.query(
        `SELECT u.name, te.duration_minutes,
                to_char(${laPazWall('te.start_time')}, 'HH24:MI') AS start_hm,
                to_char(${laPazWall('te.end_time')}, 'HH24:MI') AS end_hm
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         WHERE ${entryDay('te')} = $1::date
           AND te.end_time IS NOT NULL
           AND ${laPazWall('te.end_time')} > $2::date::timestamp
         ORDER BY u.name, te.start_time`,
        [prevDay, dateStr]
      )
    ]);

    // Agrupar tramos por trabajador (orden: nombre, hora de entrada)
    const byUser = new Map();
    for (const r of entries.rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, { name: r.name, minutes: 0, segs: [] });
      const u = byUser.get(r.user_id);
      if (r.is_open) {
        u.segs.push(`${r.start_hm}–(sigue prendido)`);
      } else {
        u.minutes += Number(r.duration_minutes) || 0;
        u.segs.push(`${r.start_hm}–${endLabel(r.end_hm, r.end_days)}${isAutoCut(r) ? ' ⚠️ corte automático' : ''}`);
      }
    }
    const missing = users.rows.filter((u) => !byUser.has(u.id) && !isAdminPhone(u.phone));

    const lines = [`📋 *Resumen del día* ${DIAS[weekdayOf(dateStr)]} ${ddmm(dateStr)}`];
    if (byUser.size) {
      lines.push(`✅ Registraron (${byUser.size}):`);
      for (const u of byUser.values()) {
        const segs = u.segs.length > MAX_SEGMENTS
          ? [...u.segs.slice(0, MAX_SEGMENTS), `… +${u.segs.length - MAX_SEGMENTS}`]
          : u.segs;
        const allOpen = u.minutes === 0 && u.segs.every((x) => x.endsWith('(sigue prendido)'));
        lines.push(`• *${u.name}*: ${segs.join(', ')}${allOpen ? '' : ` (${h(u.minutes)})`}`);
      }
    } else {
      lines.push('✅ Nadie registró hoy.');
    }
    if (lateness.rows.length) {
      lines.push(`🌙 De ayer, pasaron la medianoche (cuentan para ayer): ${lateness.rows
        .map((r) => `${r.name} ${r.start_hm}–${r.end_hm} (${h(r.duration_minutes)})`)
        .join(', ')}`);
    }
    if (missing.length) {
      lines.push(`❌ Sin registro (${missing.length}): ${missing.map((u) => u.name).join(', ')}`);
    }
    if (open.rows.length) {
      lines.push(`⏳ No apagaron (${open.rows.length}): ${open.rows
        .map((r) => `${r.name} (desde ${r.day === dateStr ? '' : `${ddmm(r.day)} `}${r.start_hm})`)
        .join(', ')}`);
    }
    return lines.join('\n');
  }

  /** Resumen semanal lun–sáb. weekStart = lunes (YYYY-MM-DD). */
  async function buildWeeklySummary(weekStart) {
    const weekEnd = addDays(weekStart, 5); // sábado
    const [totals, obs, open] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.phone,
                COALESCE(SUM(te.duration_minutes), 0)::int AS minutes
         FROM users u
         LEFT JOIN time_entries te
           ON te.user_id = u.id
          AND te.end_time IS NOT NULL
          AND ${entryDay('te')} BETWEEN $1::date AND $2::date
         GROUP BY u.id, u.name, u.phone
         HAVING COALESCE(SUM(te.duration_minutes), 0) > 0 OR bool_or(u.phone IS NOT NULL)
         ORDER BY minutes DESC, u.name`,
        [weekStart, weekEnd]
      ),
      pool.query(
        `SELECT u.name,
                ${entryDay('te')}::text AS day,
                te.observation, te.stop_reason
         FROM time_entries te
         JOIN users u ON u.id = te.user_id
         WHERE te.observation IS NOT NULL AND te.observation <> ''
           AND ${entryDay('te')} BETWEEN $1::date AND $2::date
         ORDER BY day, u.name`,
        [weekStart, weekEnd]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM time_entries WHERE end_time IS NULL`)
    ]);

    const worked = totals.rows.filter((r) => r.minutes > 0);
    const zero = totals.rows.filter((r) => r.minutes === 0 && !isAdminPhone(r.phone));
    const total = worked.reduce((a, r) => a + r.minutes, 0);

    const lines = [`📊 *Resumen semanal* ${ddmm(weekStart)}–${ddmm(weekEnd)}`];
    if (worked.length) {
      for (const r of worked) lines.push(`• *${r.name}*: ${h(r.minutes)}`);
    } else {
      lines.push('Sin horas registradas.');
    }
    lines.push(`*Total: ${h(total)}*`);
    if (zero.length) lines.push(`Sin horas: ${zero.map((r) => r.name).join(', ')}`);
    if (obs.rows.length) {
      lines.push(`⚠️ Observaciones (${obs.rows.length}):`);
      for (const r of obs.rows.slice(0, MAX_OBS_LINES)) {
        lines.push(`• ${r.name} ${ddmm(r.day)}: ${motivoCorte(r.observation, r.stop_reason)}`);
      }
      if (obs.rows.length > MAX_OBS_LINES) lines.push(`… y ${obs.rows.length - MAX_OBS_LINES} más`);
    }
    if (open.rows[0].n) lines.push(`⏳ Turnos aún abiertos: ${open.rows[0].n} (no suman)`);
    return lines.join('\n');
  }

  // ---------- Marcas persistentes ----------
  /** Reserva (kind, ref_date). true si este proceso debe enviar. */
  async function claim(kind, refDate) {
    const r = await pool.query(
      `INSERT INTO notification_log (kind, ref_date, status, attempts, claimed_at)
       VALUES ($1, $2::date, 'pending', 1, NOW())
       ON CONFLICT (kind, ref_date) DO UPDATE
         SET status = 'pending',
             attempts = notification_log.attempts + 1,
             claimed_at = NOW()
       WHERE notification_log.attempts < $3
         AND (
           (notification_log.status = 'failed'  AND notification_log.claimed_at < NOW() - INTERVAL '10 minutes')
           OR (notification_log.status = 'pending' AND notification_log.claimed_at < NOW() - INTERVAL '30 minutes')
         )
       RETURNING id`,
      [kind, refDate, MAX_ATTEMPTS]
    );
    return r.rows.length > 0;
  }

  async function markResult(kind, refDate, result) {
    if (result.ok) {
      await pool.query(
        `UPDATE notification_log SET status = 'sent', sent_at = NOW(), last_error = NULL
         WHERE kind = $1 AND ref_date = $2::date`,
        [kind, refDate]
      );
    } else {
      await pool.query(
        `UPDATE notification_log SET status = 'failed', last_error = $3
         WHERE kind = $1 AND ref_date = $2::date`,
        [kind, refDate, String(result.error || 'error').slice(0, 500)]
      );
    }
  }

  async function runOnce(kind, refDate, build) {
    if (!(await claim(kind, refDate))) return false;
    let result;
    try {
      const text = await build();
      result = await notifier.notify(text, { tag: `${kind}:${refDate}` });
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    await markResult(kind, refDate, result);
    if (!result.ok) console.error(`[whatsapp] ${kind} ${refDate} no enviado: ${result.error}`);
    return result.ok;
  }

  // ---------- Aviso "sigue prendido" (20:00 La Paz) ----------
  /**
   * Turnos abiertos que ya estaban prendidos a la hora de corte (default 20:00)
   * del día dateStr. Uno por turno y por día gracias a notification_log.
   */
  async function findLeftOn(dateStr, cutoffHHMM, now = new Date()) {
    const r = await pool.query(
      `SELECT te.id, te.user_id, u.name,
              ${entryDay('te')}::text AS day,
              u.phone,
              to_char(${laPazWall('te.start_time')}, 'HH24:MI') AS start_hm,
              FLOOR(EXTRACT(EPOCH FROM (($3::timestamptz AT TIME ZONE 'UTC') - te.start_time)) / 60)::int AS raw_minutes
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       WHERE te.end_time IS NULL
         AND ${laPazWall('te.start_time')} < ($1::date + $2::time)
       ORDER BY u.name`,
      [dateStr, cutoffHHMM, new Date(now).toISOString()]
    );
    return r.rows;
  }

  function leftOnText(row, dateStr, now = new Date()) {
    const desde = `${row.day === dateStr ? '' : `${ddmm(row.day)} `}${row.start_hm}`;
    const horas = (Math.max(0, row.raw_minutes) / 60).toFixed(1);
    return `🌙 *${row.name}* sigue prendido a las ${hhmm(now)} — desde ${desde} (${horas} h). ¿Se olvidó de apagar?`;
  }

  async function runLeftOnAlerts(p, now) {
    if (!realtimeEnabled()) return;
    const at = parseHHMM(process.env.LEFT_ON_ALERT_TIME, 20 * 60);
    if (p.hour * 60 + p.minute < at) return;
    const cutoff = `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    for (const row of await findLeftOn(p.date, cutoff, now)) {
      await runOnce(`left_on:${row.id}`, p.date, async () => leftOnText(row, p.date, now));
      // Al trabajador: mismo texto que la pregunta de las 20:00 (misma marca → no se duplica)
      if (row.phone) {
        await sendOnce(`worker_ask:${row.id}:20`, row.day, workerPromptText(row), { to: row.phone });
      }
    }
  }

  // ---------- Recordatorio de inicio (trabajadores, lun–sáb) ----------
  function reminderTimes() {
    const raw = process.env.START_REMINDER_TIMES;
    const list = (raw == null || raw.trim() === '' ? '08:00,10:00,12:00' : raw)
      .split(',').map((t) => parseHHMM(t, null)).filter((m) => m != null);
    return [...new Set(list)].sort((a, b) => a - b);
  }

  /**
   * Trabajadores a recordar en dateStr: con teléfono, que no sean el admin ni
   * usuarios de prueba (nombre test/prueba/demo), activos (algún turno o alta en
   * los últimos START_REMINDER_ACTIVE_DAYS días, default 30), sin turno ese día
   * y sin turno abierto (p. ej. uno de anoche que sigue).
   */
  async function findStartReminderTargets(dateStr) {
    const days = Math.max(1, Number(process.env.START_REMINDER_ACTIVE_DAYS) || 30);
    const admin = notifier.normalizeBoPhone(notifier.getConfig().phone);
    const r = await pool.query(
      `SELECT u.id, u.name, u.phone
       FROM users u
       WHERE u.phone IS NOT NULL
         AND u.name !~* '(^|[^a-záéíóúñ])(test|prueba|demo)([^a-záéíóúñ]|$)'
         AND (
           u.created_at >= $1::date - $2::int
           OR EXISTS (SELECT 1 FROM time_entries t
                      WHERE t.user_id = u.id AND ${entryDay('t')} >= $1::date - $2::int)
         )
         AND NOT EXISTS (SELECT 1 FROM time_entries t
                         WHERE t.user_id = u.id
                           AND (${entryDay('t')} = $1::date OR t.end_time IS NULL))
       ORDER BY u.name`,
      [dateStr, days]
    );
    return r.rows.filter((u) => {
      const p = notifier.normalizeBoPhone(u.phone);
      return p && p !== admin;
    });
  }

  const startReminderText = (u) =>
    `👋 Buen día ${u.name}, todavía no registraste tu inicio de hoy. Si ya estás trabajando, abrí la app y PRENDÉ: ${appUrl()}`;

  async function runStartReminders(p) {
    if (!realtimeEnabled() || !notifier.workerAlertsEnabled()) return;
    if (p.weekday < 1 || p.weekday > 6) return;
    const minuteOfDay = p.hour * 60 + p.minute;
    // Solo el último horario alcanzado (si el server estuvo caído no manda varios juntos),
    // y como mucho 2 h tarde.
    const due = reminderTimes().filter((m) => m <= minuteOfDay && minuteOfDay - m < 120);
    if (!due.length) return;
    const slot = due[due.length - 1];
    const label = `${String(Math.floor(slot / 60)).padStart(2, '0')}${String(slot % 60).padStart(2, '0')}`;
    for (const u of await findStartReminderTargets(p.date)) {
      await sendOnce(`worker_start_reminder:${u.id}:${label}`, p.date, startReminderText(u), { to: u.phone });
    }
  }

  // ---------- Scheduler (cada minuto) ----------
  let ticking = false;
  async function tick(now = new Date()) {
    if (ticking) return;
    if (!notifier.getConfig().enabled) return; // no marcar nada si está deshabilitado
    ticking = true;
    try {
      const p = laPazParts(now);
      const minuteOfDay = p.hour * 60 + p.minute;
      const dailyAt = parseHHMM(process.env.DAILY_SUMMARY_TIME, 21 * 60 + 30);
      const weeklyAt = parseHHMM(process.env.WEEKLY_SUMMARY_TIME, 21 * 60 + 45);

      try {
        await runLeftOnAlerts(p, now);
      } catch (e) {
        console.error('[whatsapp] left_on:', e.message);
      }
      try {
        await runStartReminders(p);
      } catch (e) {
        console.error('[whatsapp] start_reminder:', e.message);
      }

      if (p.weekday >= 1 && p.weekday <= 6 && minuteOfDay >= dailyAt) {
        await runOnce('daily_summary', p.date, () => buildDailySummary(p.date));
      }
      if (p.weekday === 6 && minuteOfDay >= weeklyAt) {
        const monday = addDays(p.date, -5);
        await runOnce('weekly_summary', monday, () => buildWeeklySummary(monday));
      }
    } catch (e) {
      console.error('[whatsapp] scheduler:', e.message);
    } finally {
      ticking = false;
    }
  }

  function startScheduler({ firstDelayMs = 15000 } = {}) {
    setTimeout(() => tick(), firstDelayMs);
    return setInterval(() => tick(), 60 * 1000);
  }

  return {
    alertStart,
    alertStop,
    alertAutoCut,
    alertAsk,
    alertContinue,
    buildDailySummary,
    buildWeeklySummary,
    findLeftOn,
    findStartReminderTargets,
    leftOnText,
    tick,
    startScheduler,
    laPazParts,
    addDays,
    motivoCorte
  };
}

module.exports = { createWhatsappReports };
