# ⏱️ Control de Horas Laborales

App simple (PWA) para registrar turnos continuos del personal. UI en español. Zona horaria: **America/La_Paz**.

## Características

- **Login por teléfono**: el número identifica al usuario; la “contraseña” es el mismo teléfono (grupo cerrado).
- **Sesión persistente**: `localStorage` + PWA; no hay que volver a entrar cada vez.
- **Timer en servidor**: un turno abierto (`end_time` null) sigue corriendo si cerrás la app; al reabrir se reanuda desde `start_time`.
- **Turno continuo**: un solo inicio/fin por jornada (sin corte de mediodía). Solo un turno abierto por usuario.
- **Resúmenes**: HOY (“estuvo X horas”), SEMANA (lunes–sábado) y totales día a día. Tras **APAGAR**, confirmación de horas del turno.
- **Redondeo a medias horas / horas** (ver abajo).
- **Recordatorios** (Notification API + service worker): aviso para **prender** (~08:00) y **apagar** (~22:00) hora La Paz; mientras el turno está activo, avisos al cruzar >20 min (media hora) y >50 min (hora completa) en cada tramo de hora.
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

## API principal

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/login` o `/register` | `{ phone, name? }` — alta/entrada por teléfono |
| POST | `/start` | Abre turno (`user_id`) |
| POST | `/stop` | Cierra turno (`entry_id` o `user_id`); responde `raw_minutes`, `duration_minutes` (redondeado) y `message` |
| GET | `/active/:user_id` | Turno abierto o null |
| GET | `/daily/:user_id` | Total de hoy (La Paz) |
| GET | `/weekly/:user_id` | Total lun–sáb |
| GET | `/week-days/:user_id` | Array `{ date, hours }` lun–sáb |
| GET | `/all-users` | Admin: usuarios + teléfono + totales |

## Cómo probar

1. Configurar `DATABASE_URL` y `npm start`.
2. Abrir la app → ingresar teléfono + nombre (1ª vez) → ENTRAR.
3. Recargar: debe seguir logueado; si hay turno abierto, el timer continúa y muestra “Acreditaría: X.X h”.
4. PRENDER → esperar → APAGAR → ver banner/alert con horas acreditadas y explicación del redondeo; actualizar HOY/SEMANA.
5. Concedir notificaciones; con la app abierta, los recordatorios se evalúan cada minuto (hora La Paz). Con turno activo, al pasar 21 y 51 min de cada hora deberían llegar avisos de media hora / hora completa.

## Estructura

- `server.js` — API + migración de `phone` + índices + redondeo
- `index.html` — UI PWA
- `sw.js` — cache v4 + notificaciones por mensaje
- `manifest.json` — metadatos PWA
- `package.json` — dependencias