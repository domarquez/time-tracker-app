# ⏱️ Control de Horas Laborales

App simple (PWA) para registrar turnos continuos del personal. UI en español. Zona horaria: **America/La_Paz**.

## Características

- **Login por teléfono**: el número identifica al usuario; la “contraseña” es el mismo teléfono (grupo cerrado).
- **Sesión persistente**: `localStorage` + PWA; no hay que volver a entrar cada vez.
- **Timer en servidor**: un turno abierto (`end_time` null) sigue corriendo si cerrás la app; al reabrir se reanuda desde `start_time`.
- **Turno continuo**: un solo inicio/fin por jornada (sin corte de mediodía). Solo un turno abierto por usuario.
- **Resúmenes**: HOY (“estuvo X horas”), SEMANA (lunes–sábado) y totales día a día. Tras **APAGAR**, confirmación de horas del turno.
- **Redondeo a medias horas / horas** (ver abajo).
- **Recordatorios** (Notification API + service worker): aviso para **prender** (~08:00) hora La Paz; mientras el turno está activo, avisos al cruzar >20 min (media hora) y >50 min (hora completa) en cada tramo de hora.
- **Chequeo nocturno** (servidor autoritativo, America/La_Paz). Un turno **puede pasar la medianoche** (p. ej. hasta las 02:00) mientras el trabajador vaya confirmando:
  - Preguntas “¿Seguís?” (modal Seguir/Apagar + notificación + WhatsApp al trabajador) en los checkpoints **20:00**, **23:00** y luego **cada hora** (00:00, 01:00, 02:00…; `NIGHT_ASK_EVERY_MIN`, default 60). Solo los checkpoints posteriores al inicio del turno (si prende a las 21:00, la primera es a las 23:00).
  - **Seguir** → no pregunta hasta el siguiente checkpoint (y el admin recibe `🔁 *Nombre* confirmó que sigue trabajando`).
  - **Sin respuesta en 15 min** (`NIGHT_ASK_TIMEOUT_MIN`) → corte automático con observación `Corte automático: sin respuesta a las HH:MM` (`sin_respuesta_noche`). Se corta al vencer la espera (no se acreditan horas sin confirmar aunque el cron se atrase). GPS no requerido.
  - **Tope de seguridad**: `MAX_SHIFT_HOURS` (default **16 h**) → corte automático al cumplir ese largo, aunque haya confirmado (`tope_turno`; `end_time` = inicio + tope).
  - Ya **no** hay corte fijo a las 00:00.
- **Día de un turno**: todas sus horas cuentan para el **día La Paz en que empezó** (columna `date`), incluida la parte después de medianoche — en HOY, SEMANA, día a día y en los resúmenes de WhatsApp. Un turno nuevo a la mañana siguiente (p. ej. 10:00 tras apagar a las 02:00) es otro turno, en su propio día. Sigue rigiendo un solo turno abierto por usuario.
- **Admin**: panel con lista de usuarios (incluye teléfono).
- **Instalable** como PWA.

## Reglas de redondeo

Al **APAGAR**, solo se acreditan **medias horas** y **horas completas**. Sobre los minutos sobrantes de cada hora transcurrida:

| Minutos sobrantes | Acreditación | Ejemplo |
|-------------------|--------------|---------|
| ≤ 20 | Se pierden → solo horas enteras | 6h15 → **6.0 h** |
| > 20 y ≤ 50 | Media hora (+0.5) | 6h21 → **6.5 h**; 6h50 → **6.5 h** |
| > 50 | Hora completa (+1.0) | 6h51 → **7.0 h** |

Más ejemplos: 0h19 → 0 h; 0h21 → 0.5 h; 1h10 → 1.0 h; 1h21 → 1.5 h; 1h51 → 2.0 h.

Los labels se muestran en decimales `.0` / `.5` (ej. `10.5 horas`).

## Limitaciones de notificaciones

- Los recordatorios se programan en el cliente (chequeo periódico). Si el SO suspende la PWA en segundo plano, **pueden no dispararse** hasta reabrir la app.
- **iOS/Safari**: las notificaciones web tienen restricciones importantes (a menudo solo con la app instalada en la pantalla de inicio y con permisos). No hay push remoto en este proyecto.
- Android Chrome suele funcionar mejor con la PWA instalada y permiso concedido.

## Tecnologías

- **Backend**: Node.js + Express
- **Base de datos**: Neon Postgres (`DATABASE_URL`)
- **Frontend**: HTML + Tailwind CDN + JavaScript
- **Despliegue**: Railway (recomendado)

## Variables de entorno

Ver `.env.example`:

```
DATABASE_URL=postgres://...
PORT=3000
```

> Neon/Postgres suelen requerir SSL; el servidor usa `rejectUnauthorized: false` cuando hay `DATABASE_URL`.

### WhatsApp al admin (Evolution API v2)

Las alertas se envían **solo** a `ADMIN_WHATSAPP_PHONE` mediante una instancia propia de **Evolution API v2**:

```
POST {EVOLUTION_BASE_URL}/message/sendText/{EVOLUTION_INSTANCE}
apikey: <EVOLUTION_API_KEY>
Content-Type: application/json

{ "number": "59167827075", "text": "..." }
```

Éxito = respuesta 2xx (Evolution devuelve 201 con `key.id`). Si `WHATSAPP_PROVIDER` no está definido y existen `EVOLUTION_BASE_URL` + `EVOLUTION_API_KEY`, se usa Evolution automáticamente.

| Variable | Default | Descripción |
|----------|---------|-------------|
| `EVOLUTION_BASE_URL` | — | URL base de Evolution (se quita la `/` final). |
| `EVOLUTION_API_KEY` | — | Header `apikey`. |
| `EVOLUTION_INSTANCE` | `precios-ferreterias` | Nombre de la instancia. |
| `ADMIN_WHATSAPP_PHONE` | `+59167827075` | Único destinatario (se envían solo los dígitos). |
| `WHATSAPP_PROVIDER` | auto | `evolution` \| `callmebot` \| `textmebot`. Auto: `evolution` si hay URL + apikey de Evolution; si no, `callmebot`. |
| `WHATSAPP_ENABLED` | `true` si el proveedor está configurado | `false` apaga todos los envíos. **Sin configuración no se envía nada** (solo log; nunca rompe). |
| `WHATSAPP_REALTIME_ENABLED` | `true` | `false` = solo resúmenes (sin alertas de PRENDER/APAGAR/corte). |
| `WHATSAPP_MIN_GAP_MS` | `8000` | Separación mínima entre mensajes (la instancia se comparte con otros envíos). |
| `DAILY_SUMMARY_TIME` | `21:30` | Hora (La Paz) del resumen diario, lunes a sábado. |
| `WEEKLY_SUMMARY_TIME` | `21:45` | Hora (La Paz) del resumen semanal, sábado. |
| `LEFT_ON_ALERT_TIME` | `20:00` | Hora (La Paz) del aviso “sigue prendido” (todos los días; se apaga con `WHATSAPP_REALTIME_ENABLED=false`). |
| `WHATSAPP_WORKER_ALERTS` | `true` | `false` = no mandar nada a los trabajadores (solo al admin). |
| `START_REMINDER_TIMES` | `08:00,10:00,12:00` | Recordatorios de inicio al trabajador (lun–sáb, La Paz). |
| `START_REMINDER_ACTIVE_DAYS` | `30` | Solo se recuerda a usuarios con algún turno o alta en los últimos N días. |
| `APP_URL` | `https://time-tracker-app-production-2a17.up.railway.app` | Link que va en los mensajes al trabajador. |
| `WHATSAPP_JITTER_MS` | `3000` | Espera aleatoria extra (0..N ms) sumada a `WHATSAPP_MIN_GAP_MS` entre mensajes. |
| `NIGHT_ASK_EVERY_MIN` | `60` | Frecuencia de las preguntas después de las 23:00 (mín. 15). |
| `NIGHT_ASK_TIMEOUT_MIN` | `15` | Minutos para responder antes del corte automático. |
| `MAX_SHIFT_HOURS` | `16` | Tope de largo de turno (corte automático). |

**Alternativas (opcionales):** `WHATSAPP_PROVIDER=callmebot` + `CALLMEBOT_APIKEY` (API gratuita de CallMeBot) o `WHATSAPP_PROVIDER=textmebot` + `TEXTMEBOT_APIKEY`.

**Qué se envía** (hora America/La_Paz):

Al **admin** (`ADMIN_WHATSAPP_PHONE`):
- Tiempo real: `🟢 *Nombre* prendió a las HH:MM`, `🔴 *Nombre* apagó a las HH:MM — X.X h`, `⚠️ *Nombre*: corte automático (motivo, desde HH:MM) — X.X h` (pregunta sin respuesta o tope de turno).
- **Seguir**: `🔁 *Nombre* confirmó que sigue trabajando (23:00, desde 18:00)` — uno por confirmación.
- **Sigue prendido** (20:00, todos los días): `🌙 *Nombre* sigue prendido a las 20:00 — desde 08:02 (12.0 h). ¿Se olvidó de apagar?` — una vez por turno abierto y por día. Solo turnos que ya estaban prendidos antes de las 20:00.
- **Resumen diario** lun–sáb 21:30: por trabajador, cada entrada–salida del día en hora La Paz y las horas acreditadas, p. ej. `• *Carmelo*: 08:02–12:10, 13:05–17:40 (8.5 h)`; turnos que pasan la medianoche como `22:00–02:10 (+1 día)`; abiertos como `08:00–(sigue prendido)`; cortes automáticos con `⚠️ corte automático`. Línea `🌙 De ayer, pasaron la medianoche (cuentan para ayer)` con los turnos de ayer que terminaron de madrugada. Luego quién no registró (usuarios con teléfono sin turno hoy, sin el admin) y quién no apagó.
- **Resumen semanal** sábado 21:45: horas por trabajador lun–sáb + total, y observaciones (cortes automáticos). Un turno del sábado que pasa la medianoche cuenta para el sábado (si a las 21:45 sigue abierto aparece en “Turnos aún abiertos”).

Al **trabajador** (su teléfono de login, normalizado a `591XXXXXXXX`; se desactiva con `WHATSAPP_WORKER_ALERTS=false`; nunca recibe resúmenes):
- En cada pregunta nocturna (20:00, 23:00, cada hora): `⏰ Tu turno sigue prendido desde HH:MM. Abrí la app y confirmá si seguís trabajando o apagá: <APP_URL>`.
- Corte automático: `Tu turno se apagó automáticamente a las HH:MM por falta de confirmación. Se acreditaron X.X h.` (o `por llegar al tope de 16 h de turno`).
- Recordatorio de inicio lun–sáb a las 08:00, 10:00 y 12:00 (`START_REMINDER_TIMES`) solo si ese día todavía no prendió: `👋 Buen día Nombre, todavía no registraste tu inicio de hoy. Si ya estás trabajando, abrí la app y PRENDÉ: <APP_URL>`. Se excluye al admin, a nombres con test/prueba/demo, a quien tiene un turno abierto y a usuarios sin actividad en 30 días. Si el server estuvo caído, solo se manda el último horario alcanzado (hasta 2 h tarde).

`notifier.js` solo permite destinatarios distintos del admin para estos tipos de mensaje (`worker_ask`, `worker_autocut`, `worker_left_on`, `worker_start_reminder`). Cada aviso queda marcado en `notification_log` (p. ej. `worker_ask:<turno>:<fase>`, `continue:<turno>:<fase>`, `autocut:<turno>`, `worker_start_reminder:<usuario>:0800`) → sin duplicados.

> **Zona horaria:** `time_entries.start_time` / `end_time` son `TIMESTAMP` sin zona y guardan la hora **UTC**. Para pasarlos a La Paz en SQL hay que usar `(col AT TIME ZONE 'UTC') AT TIME ZONE 'America/La_Paz'` (helper `laPazWall` en `tz-sql.js`); `col AT TIME ZONE 'America/La_Paz'` solo suma 4 h y manda los turnos de la tarde/noche al día siguiente.

Los envíos pasan por una cola en memoria (≥ 8 s + 0–3 s aleatorios entre mensajes, 1 reintento; la instancia de Evolution es compartida) y nunca demoran las respuestas HTTP. Los resúmenes quedan marcados en la tabla `notification_log (kind, ref_date)`: un reinicio no duplica, y si el servidor estuvo caído a la hora programada se envía al volver (mismo día). Si falla, se reintenta cada 10 min (máx. 3 intentos).

**Probar:** `POST /admin/test-whatsapp` con `{ "password": "admin" }` → envía `✅ Prueba de Control de Horas`. Vista previa de resúmenes (no marca `notification_log`): `POST /admin/whatsapp-summary` con `{ "password": "admin", "kind": "daily"|"weekly", "date"?: "YYYY-MM-DD", "send"?: true }`.

## API principal

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/login` o `/register` | `{ phone, name? }` — alta/entrada por teléfono |
| POST | `/start` | Abre turno (`user_id`) |
| POST | `/stop` | Cierra turno (`entry_id` o `user_id`); opcional `observation` / `stop_reason`; `auto: true` omite GPS |
| POST | `/auto-stop` | Corte sin GPS (servidor/cliente) con observación |
| POST | `/night-continue` | `{ user_id, entry_id?, phase }` — Seguir en chequeo nocturno (`phase` = checkpoint en horas desde la medianoche del día de inicio: `20`, `23`, `24` = 00:00, `25` = 01:00…) |
| GET | `/active/:user_id` | Turno abierto + flags `night` (`ask_continue`, `phase`, `auto_stopped`) |
| GET | `/night-check/:user_id` | Solo chequeo nocturno (`ask_continue`, `phase`, `auto_stopped`) |
| GET | `/daily/:user_id` | Total de hoy (La Paz) |
| GET | `/weekly/:user_id` | Total lun–sáb |
| GET | `/week-days/:user_id` | Array `{ date, hours }` lun–sáb |
| GET | `/all-users` | Admin: usuarios + teléfono + totales |
| POST | `/admin/test-whatsapp` | Admin (`password`): mensaje de prueba por WhatsApp |
| POST | `/admin/whatsapp-summary` | Admin (`password`): vista previa / envío manual del resumen diario o semanal |

## Cómo probar

1. Configurar `DATABASE_URL` y `npm start`.
2. Abrir la app → ingresar teléfono + nombre (1ª vez) → ENTRAR.
3. Recargar: debe seguir logueado; si hay turno abierto, el timer continúa y muestra “Acreditaría: X.X h”.
4. PRENDER → esperar → APAGAR → ver banner/alert con horas acreditadas y explicación del redondeo; actualizar HOY/SEMANA.
5. Conceder notificaciones; con la app abierta, los recordatorios se evalúan cada minuto (hora La Paz). Con turno activo, al pasar 21 y 51 min de cada hora deberían llegar avisos de media hora / hora completa.
6. Chequeo nocturno: con turno abierto después de las 20:00 La Paz, debe aparecer el modal Seguir/Apagar y una notificación. Seguir silencia hasta el siguiente checkpoint (23:00, 00:00, 01:00…); sin respuesta en 15 min (o cron del servidor) cierra con observación. Tope: 16 h.

## Estructura

- `server.js` — API + migración de `phone` + índices + redondeo
- `notifier.js` — envío WhatsApp (Evolution API v2; alternativas CallMeBot / TextMeBot) con cola y reintento
- `whatsapp-reports.js` — alertas en tiempo real + aviso 20:00 + resúmenes programados (`notification_log`)
- `tz-sql.js` — conversión UTC → La Paz en SQL (`start_time`/`end_time` son `TIMESTAMP` sin zona en UTC)
- `index.html` — UI PWA
- `sw.js` — cache v9 + notificaciones por mensaje
- `manifest.json` — metadatos PWA
- `package.json` — dependencias