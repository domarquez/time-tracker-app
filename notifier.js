/**
 * Notificador WhatsApp para el admin (proveedor intercambiable).
 *
 * Proveedores:
 *  - callmebot (default): GET https://api.callmebot.com/whatsapp.php?phone=..&text=..&apikey=..
 *  - textmebot:           GET https://api.textmebot.com/send.php?recipient=..&apikey=..&text=..
 *
 * Env:
 *  WHATSAPP_PROVIDER     callmebot | textmebot (default callmebot)
 *  CALLMEBOT_APIKEY      apikey de CallMeBot
 *  TEXTMEBOT_APIKEY      apikey de TextMeBot (si WHATSAPP_PROVIDER=textmebot)
 *  ADMIN_WHATSAPP_PHONE  destino (default +59167827075)
 *  WHATSAPP_ENABLED      true/false (default: true si hay apikey)
 *  WHATSAPP_MIN_GAP_MS   separación mínima entre envíos (default 8000)
 *
 * Nunca lanza excepciones hacia el llamador: sin apikey solo loguea y omite.
 * Los envíos pasan por una cola en memoria: ≥ MIN_GAP_MS entre requests,
 * 1 reintento ante fallo. notify() devuelve una promesa que se puede ignorar
 * (fire-and-forget) — nunca bloquear respuestas HTTP esperándola.
 */
const https = require('https');

const DEFAULT_PHONE = '+59167827075';
const MAX_QUEUE = 50;
const REQUEST_TIMEOUT_MS = 15000;

function envBool(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function getConfig() {
  const provider = String(process.env.WHATSAPP_PROVIDER || 'callmebot').trim().toLowerCase();
  const apikey = provider === 'textmebot'
    ? (process.env.TEXTMEBOT_APIKEY || process.env.CALLMEBOT_APIKEY || '').trim()
    : (process.env.CALLMEBOT_APIKEY || '').trim();
  const phone = (process.env.ADMIN_WHATSAPP_PHONE || DEFAULT_PHONE).trim();
  const enabled = envBool(process.env.WHATSAPP_ENABLED, !!apikey) && !!apikey;
  const minGapMs = Math.max(0, Number(process.env.WHATSAPP_MIN_GAP_MS) || 8000);
  return { provider, apikey, phone, enabled, minGapMs };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 4000) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
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

const providers = {
  callmebot: {
    buildUrl({ phone, apikey }, text) {
      return `https://api.callmebot.com/whatsapp.php?${qs({ phone, text, apikey })}`;
    },
    // Éxito típico: "... <b>Message queued.</b> You will receive it in a few seconds."
    isOk({ status, body }) {
      if (status < 200 || status >= 300) return false;
      const b = String(body || '');
      if (/queued|sent/i.test(b)) return true;
      return !/error|invalid|not activated|apikey/i.test(b);
    }
  },
  textmebot: {
    buildUrl({ phone, apikey }, text) {
      return `https://api.textmebot.com/send.php?${qs({ recipient: phone, apikey, text })}`;
    },
    isOk({ status, body }) {
      if (status < 200 || status >= 300) return false;
      return !/error|invalid|fail/i.test(String(body || ''));
    }
  }
};

async function sendNow(text, cfg = getConfig()) {
  const provider = providers[cfg.provider];
  if (!provider) throw new Error(`WHATSAPP_PROVIDER desconocido: ${cfg.provider}`);
  const res = await httpGet(provider.buildUrl(cfg, text));
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
  const wait = lastSendAt + cfg.minGapMs - Date.now();
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
          await sendNow(job.text, cfg);
          lastErr = null;
          console.log(`[whatsapp] enviado (${job.tag || 'msg'}, intento ${attempt})`);
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
 * @param {{ tag?: string }} [opts]
 */
function notify(text, opts = {}) {
  try {
    const cfg = getConfig();
    const msg = String(text || '').trim();
    if (!msg) return Promise.resolve({ ok: false, skipped: true, error: 'texto vacío' });
    if (!cfg.enabled) {
      console.log(`[whatsapp] deshabilitado (sin apikey o WHATSAPP_ENABLED=false); omitido: ${msg.split('\n')[0].slice(0, 80)}`);
      return Promise.resolve({ ok: false, skipped: true, error: 'deshabilitado' });
    }
    if (queue.length >= MAX_QUEUE) {
      const dropped = queue.shift();
      console.error(`[whatsapp] cola llena; descartado: ${dropped.tag || 'msg'}`);
      dropped.resolve({ ok: false, error: 'descartado (cola llena)' });
    }
    return new Promise((resolve) => {
      queue.push({ text: msg, tag: opts.tag, resolve });
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
    has_apikey: !!cfg.apikey,
    queue_length: queue.length
  };
}

module.exports = { notify, status, getConfig, providers, _sendNow: sendNow };
