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
- **Chequeo nocturno** (servidor autoritativo, America/La_Paz):
  - Desde **20:00**: si el turno sigue abierto, pregunta cada ventana de **15 min** (notificación + modal Seguir/Apagar). Sin respuesta → corte automático con observación (`sin_respuesta_noche`).
  - Si responde **Seguir**: deja de preguntar hasta las **23:00**.
  - A las **23:00**: pregunta una vez más. Seguir → hasta medianoche; Apagar → cierra con observación; sin respuesta → corte automático.
  - A las **00:00**: siempre corte automático (`Corte automático a medianoche`). GPS no requerido en auto-corte.
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

### WhatsApp al admin (CallMeBot)

| Variable | Default | Descripción |
|----------|---------|-------------|
| `CALLMEBOT_APIKEY` | — | Apikey de CallMeBot. **Sin apikey no se envía nada** (solo se loguea y se omite; nunca rompe). |
| `ADMIN_WHATSAPP_PHONE` | `+59167827075` | Número del admin (formato internacional con `+`). |
| `WHATSAPP_ENABLED` | `true` si hay apikey | `false` apaga todos los envíos. |
| `WHATSAPP_PROVIDER` | `callmebot` | `textmebot` para usar TextMeBot (`TEXTMEBOT_APIKEY`). |
| `TEXTMEBOT_APIKEY` | — | Solo si `WHATSAPP_PROVIDER=textmebot`. |
| `WHATSAPP_REALTIME_ENABLED` | `true` | `false` = solo resúmenes (sin alertas de PRENDER/APAGAR/corte). |
| `WHATSAPP_MIN_GAP_MS` | `8000` | Separación mínima entre mensajes (límite del plan gratuito). |
| `DAILY_SUMMARY_TIME` | `21:30` | Hora (La Paz) del resumen diario, lunes a sábado. |
| `WEEKLY_SUMMARY_TIME` | `21:45` | Hora (La Paz) del resumen semanal, sábado. |

**Obtener la apikey:** agendar el número de CallMeBot (ver https://www.callmebot.com/blog/free-api-whatsapp-messages/), enviarle por WhatsApp *"I allow callmebot to send me messages"* desde el teléfono del admin y copiar la apikey que responde en `CALLMEBOT_APIKEY` (Railway → Variables).

**Qué se envía** (hora America/La_Paz):

- Tiempo real: `🟢 *Nombre* prendió a las HH:MM`, `🔴 *Nombre* apagó a las HH:MM — X.X h`, `⚠️ *Nombre*: corte automático (motivo) — X.X h` (20h/23h sin respuesta, medianoche).
- **Resumen diario** lun–sáb 21:30: quién registró hoy (horas), quién no registró (usuarios con teléfono sin turno hoy) y quién no apagó.
- **Resumen semanal** sábado 21:45: horas por trabajador lun–sáb + total, y observaciones (cortes automáticos).

Los envíos pasan por una cola en memoria (≥ 8 s entre mensajes, 1 reintento) y nunca demoran las respuestas HTTP. Los resúmenes quedan marcados en la tabla `notification_log (kind, ref_date)`: un reinicio no duplica, y si el servidor estuvo caído a la hora programada se envía al volver (mismo día). Si falla, se reintenta cada 10 min (máx. 3 intentos).

**Probar:** `POST /admin/test-whatsapp` con `{ "password": "admin" }` → envía `✅ Prueba de Control de Horas`. Vista previa de resúmenes (no marca `notification_log`): `POST /admin/whatsapp-summary` con `{ "password": "admin", "kind": "daily"|"weekly", "date"?: "YYYY-MM-DD", "send"?: true }`.

## API principal

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/login` o `/register` | `{ phone, name? }` — alta/entrada por teléfono |
| POST | `/start` | Abre turno (`user_id`) |
| POST | `/stop` | Cierra turno (`entry_id` o `user_id`); opcional `observation` / `stop_reason`; `auto: true` omite GPS |
| POST | `/auto-stop` | Corte sin GPS (servidor/cliente) con observación |
| POST | `/night-continue` | `{ user_id, entry_id?, phase: '20'\|'23' }` — Seguir en chequeo nocturno |
| GET | `/active/:user_id` | Turno abierto + flags `night` (`ask_continue`, `phase`, `auto_stopped`) |
| GET | `/night-check/:user_id` | Solo chequeo nocturno (`ask_continue`, `phase`, `midnight_closed`) |
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
6. Chequeo nocturno: con turno abierto después de las 20:00 La Paz, debe aparecer el modal Seguir/Apagar y una notificación. Seguir silencia hasta 23:00; sin respuesta en 15 min (o cron del servidor) cierra con observación. A medianoche siempre corta.

## Estructura

- `server.js` — API + migración de `phone` + índices + redondeo
- `notifier.js` — envío WhatsApp (CallMeBot / TextMeBot) con cola y reintento
- `whatsapp-reports.js` — alertas en tiempo real + resúmenes programados (`notification_log`)
- `index.html` — UI PWA
- `sw.js` — cache v8 + notificaciones por mensaje
- `manifest.json` — metadatos PWA
- `package.json` — dependencias