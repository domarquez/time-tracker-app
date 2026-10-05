/**
 * Notificador WhatsApp para el admin (proveedor intercambiable).
 *
 * Proveedores:
 *  - evolution (Evolution API v2, self-hosted):
 *      POST {EVOLUTION_BASE_URL}/message/sendText/{EVOLUTION_INSTANCE}
 *      headers: apikey: EVOLUTION_API_KEY ; body: { number: "591...", text }
 *  - callmebot: GET https://api.callmebot.com/whatsapp.php?phone=..&text=..&apikey=..
 *  - textmebot: GET https://api.textmebot.com/send.php?recipient=..&apikey=..&text=..
 *
 * Selección: WHATSAPP_PROVIDER explícito; si no está y existen
 * EVOLUTION_BASE_URL + EVOLUTION_API_KEY → evolution; si no → callmebot.
 *
 * Env:
 *  WHATSAPP_PROVIDER     evolution | callmebot | textmebot
 *  EVOLUTION_BASE_URL    p.ej. https://evo.midominio.com (sin barra final)
 *  EVOLUTION_API_KEY     apikey de la instancia / global
 *  EVOLUTION_INSTANCE    nombre de instancia (default precios-ferreterias)
 *  CALLMEBOT_APIKEY      apikey de CallMeBot
 *  TEXTMEBOT_APIKEY      apikey de TextMeBot
 *  ADMIN_WHATSAPP_PHONE  único destino (default +59167827075)
 *  WHATSAPP_ENABLED      true/false (default: true si el proveedor está configurado)
 *  WHATSAPP_MIN_GAP_MS   separación mínima entre envíos (default 8000)
 *  WHATSAPP_JITTER_MS    espera aleatoria extra 0..N ms entre envíos (default 3000)
 *  WHATSAPP_WORKER_ALERTS true/false (default true): avisos de "turno prendido"
 *                        también al WhatsApp del trabajador
 *
 * Nunca lanza excepciones hacia el llamador: sin configuración solo loguea y omite.
 * Los envíos pasan por una cola en memoria: ≥ MIN_GAP_MS entre requests,
 * 1 reintento ante fallo. notify() devuelve una promesa que se puede ignorar
 * (fire-and-forget) — nunca bloquear respuestas HTTP esperándola.
 * Destino: ADMIN_WHATSAPP_PHONE por defecto. Solo los avisos de turno
 * (WORKER_TAGS: sigue prendido / pregunta de continuar / corte automático)
 * pueden ir al teléfono del trabajador (opts.to), y solo si
 * WHATSAPP_WORKER_ALERTS no está en false. Resúmenes nunca van a trabajadores.
 */
const http = require('http');
const https = require('https');

const DEFAULT_PHONE = '+59167827075';
const DEFAULT_EVOLUTION_INSTANCE = 'precios-ferreterias';
const MAX_QUEUE = 50;
const REQUEST_TIMEOUT_MS = 15000;
/** Únicos tipos de mensaje que pueden ir a un trabajador (prefijo del tag). */
const WORKER_TAGS = [
  'worker_left_on', 'worker_ask', 'worker_autocut', 'worker_start_reminder', 'worker_receipt', 'worker_weekly'
];

function envBool(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

const env = (k) => String(process.env[k] || '').trim();

/**
 * Teléfono boliviano → '591XXXXXXXX' (solo dígitos). Acepta '+591 7xxxxxxx',
 * '591…', '7xxxxxxx' / '6xxxxxxx'. Devuelve '' si no parece un celular válido.
 */
function normalizeBoPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^[67]\d{7}$/.test(d)) d = `591${d}`;
  return /^591[67]\d{7}$/.test(d) ? d : '';
}

const workerAlertsEnabled = () => envBool(process.env.WHATSAPP_WORKER_ALERTS, true);
const isWorkerTag = (tag) => WORKER_TAGS.some((t) => String(tag || '').split(':')[0] === t);

function getConfig() {
  const evolution = {
    baseUrl: env('EVOLUTION_BASE_URL').replace(/\/+$/, ''),
    apiKey: env('EVOLUTION_API_KEY'),
    instance: env('EVOLUTION_INSTANCE') || DEFAULT_EVOLUTION_INSTANCE
  };
  const explicit = env('WHATSAPP_PROVIDER').toLowerCase();
  const provider = explicit
    || (evolution.baseUrl && evolution.apiKey ? 'evolution' : 'callmebot');

  let apikey = '';
  let configured = false;
  if (provider === 'evolution') {
    apikey = evolution.apiKey;
    configured = !!(evolution.baseUrl && evolution.apiKey && evolution.instance);
  } else if (provider === 'textmebot') {
    apikey = env('TEXTMEBOT_APIKEY') || env('CALLMEBOT_APIKEY');
    configured = !!apikey;
  } else if (provider === 'callmebot') {
    apikey = env('CALLMEBOT_APIKEY');
    configured = !!apikey;
  }

  const phone = env('ADMIN_WHATSAPP_PHONE') || DEFAULT_PHONE;
  const enabled = envBool(process.env.WHATSAPP_ENABLED, configured) && configured;
  const gapEnv = process.env.WHATSAPP_MIN_GAP_MS;
  const minGapMs = gapEnv != null && gapEnv !== '' && Number.isFinite(Number(gapEnv))
    ? Math.max(0, Number(gapEnv)) : 8000;
  const jitEnv = process.env.WHATSAPP_JITTER_MS;
  const jitterMs = jitEnv != null && jitEnv !== '' && Number.isFinite(Number(jitEnv))
    ? Math.max(0, Number(jitEnv)) : 3000;
  return { provider, apikey, phone, enabled, configured, minGapMs, jitterMs, evolution };
}

/** Request HTTP(S) genérico → { status, body } (body truncado). */
function httpRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error(`URL inválida: ${e.message}`));
    }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = lib.request(u, {
      method,
      headers: payload ? { ...headers, 'Content-Length': payload.length } : headers
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (data.length < 4000) data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Query string con encodeURIComponent (%20 en vez de '+', como en la doc de CallMeBot). */
function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function shortBody(body) {
  return String(body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const is2xx = (status) => status >= 200 && status < 300;

const providers = {
  evolution: {
    request(cfg, text) {
      const { baseUrl, apiKey, instance } = cfg.evolution;
      return {
        url: `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`,
        method: 'POST',
        headers: { apikey: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: String(cfg.phone).replace(/\D/g, ''), text })
      };
    },
    // Evolution v2 responde 201 con { key: { id } }
    isOk: ({ status }) => is2xx(status)
  },
  callmebot: {
    request({ phone, apikey }, text) {
      return { url: `https://api.callmebot.com/whatsapp.php?${qs({ phone, text, apikey })}` };
    },
    // Éxito típico: "... <b>Message queued.</b> You will receive it in a few seconds."
    isOk({ status, body }) {
      if (!is2xx(status)) return false;
      const b = String(body || '');
      if (/queued|sent/i.test(b)) return true;
      return !/error|invalid|not activated|apikey/i.test(b);
    }
  },
  textmebot: {
    request({ phone, apikey }, text) {
      return { url: `https://api.textmebot.com/send.php?${qs({ recipient: phone, apikey, text })}` };
    },
    isOk({ status, body }) {
      if (!is2xx(status)) return false;
      return !/error|invalid|fail/i.test(String(body || ''));
    }
  }
};

async function sendNow(text, cfg = getConfig(), to = null) {
  const provider = providers[cfg.provider];
  if (!provider) throw new Error(`WHATSAPP_PROVIDER desconocido: ${cfg.provider}`);
  const target = to ? { ...cfg, phone: `+${to}` } : cfg;
  const { url, ...opts } = provider.request(target, text);
  const res = await httpRequest(url, opts);
  if (!provider.isOk(res)) {
    throw new Error(`HTTP ${res.status}: ${shortBody(res.body)}`);
  }
  return res;
}

// ---- Cola con espaciado mínimo + 1 reintento ----
const queue = [];
let processing = false;
let lastSendAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitGap(cfg) {
  const jitter = cfg.jitterMs ? Math.floor(Math.random() * cfg.jitterMs) : 0;
  const wait = lastSendAt + cfg.minGapMs + jitter - Date.now();
  if (wait > 0) await sleep(wait);
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const cfg = getConfig();
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        await waitGap(cfg);
        lastSendAt = Date.now();
        try {
          await sendNow(job.text, cfg, job.to);
          lastErr = null;
          console.log(`[whatsapp] enviado (${job.tag || 'msg'}${job.to ? ' → trabajador' : ''}, intento ${attempt})`);
          break;
        } catch (e) {
          lastErr = e;
          console.error(`[whatsapp] fallo (${job.tag || 'msg'}, intento ${attempt}): ${e.message}`);
        }
      }
      job.resolve(lastErr ? { ok: false, error: lastErr.message } : { ok: true });
    }
  } finally {
    processing = false;
  }
}

/**
 * Encola un mensaje al admin. Devuelve Promise<{ ok, skipped?, error? }>; nunca rechaza.
 * @param {string} text
 * @param {{ tag?: string, to?: string }} [opts] to = teléfono del trabajador
 *   (solo para tags de WORKER_TAGS; si no, se ignora y se rechaza).
 */
function notify(text, opts = {}) {
  try {
    const cfg = getConfig();
    const msg = String(text || '').trim();
    if (!msg) return Promise.resolve({ ok: false, skipped: true, error: 'texto vacío' });
    if (!cfg.enabled) {
      console.log(`[whatsapp] deshabilitado (${cfg.provider} sin configurar o WHATSAPP_ENABLED=false); omitido: ${msg.split('\n')[0].slice(0, 80)}`);
      return Promise.resolve({ ok: false, skipped: true, error: 'deshabilitado' });
    }
    let to = null;
    if (opts.to != null) {
      if (!isWorkerTag(opts.tag)) {
        return Promise.resolve({ ok: false, skipped: true, error: `destinatario no permitido para ${opts.tag || 'msg'}` });
      }
      if (!workerAlertsEnabled()) {
        return Promise.resolve({ ok: false, skipped: true, error: 'avisos a trabajadores deshabilitados' });
      }
      to = normalizeBoPhone(opts.to);
      if (!to) return Promise.resolve({ ok: false, skipped: true, error: 'teléfono de trabajador inválido' });
    }
    if (queue.length >= MAX_QUEUE) {
      const dropped = queue.shift();
      console.error(`[whatsapp] cola llena; descartado: ${dropped.tag || 'msg'}`);
      dropped.resolve({ ok: false, error: 'descartado (cola llena)' });
    }
    return new Promise((resolve) => {
      queue.push({ text: msg, tag: opts.tag, to, resolve });
      processQueue().catch((e) => console.error('[whatsapp] cola:', e.message));
    });
  } catch (e) {
    console.error('[whatsapp] notify:', e.message);
    return Promise.resolve({ ok: false, error: e.message });
  }
}

function status() {
  const cfg = getConfig();
  const p = cfg.phone || '';
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    phone: p.length > 4 ? `${p.slice(0, 4)}…${p.slice(-3)}` : p,
    configured: cfg.configured,
    has_apikey: !!cfg.apikey,
    ...(cfg.provider === 'evolution'
      ? { evolution_instance: cfg.evolution.instance, evolution_base_url: cfg.evolution.baseUrl || null }
      : {}),
    worker_alerts: workerAlertsEnabled(),
    queue_length: queue.length
  };
}

module.exports = {
  notify, status, getConfig, providers, normalizeBoPhone, workerAlertsEnabled, WORKER_TAGS, _sendNow: sendNow
};
