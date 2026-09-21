# ⏱️ Control de Horas Laborales

App simple (PWA) para registrar turnos continuos del personal. UI en español. Zona horaria: **America/La_Paz**.

## Características

- **Login por teléfono**: el número identifica al usuario; la “contraseña” es el mismo teléfono (grupo cerrado).
- **Sesión persistente**: `localStorage` + PWA; no hay que volver a entrar cada vez.
- **Timer en servidor**: un turno abierto (`end_time` null) sigue corriendo si cerrás la app; al reabrir se reanuda desde `start_time`.
- **Turno continuo**: un solo inicio/fin por jornada (sin corte de mediodía). Solo un turno abierto por usuario.
- **Resúmenes**: HOY (“estuvo X horas”), SEMANA (lunes–sábado) y totales día a día. Tras **APAGAR**, confirmación de horas del turno.
- **Redondeo** a 15 minutos hacia abajo al detener (ej. 9:14 → 9:00).
- **Recordatorios** (Notification API + service worker): aviso para **prender** (~08:00) y **apagar** (~22:00) hora La Paz, mientras la app está abierta o en primer plano según el SO.
- **Admin**: panel con lista de usuarios (incluye teléfono).
- **Instalable** como PWA.

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
| POST | `/stop` | Cierra turno (`entry_id` o `user_id`) |
| GET | `/active/:user_id` | Turno abierto o null |
| GET | `/daily/:user_id` | Total de hoy (La Paz) |
| GET | `/weekly/:user_id` | Total lun–sáb |
| GET | `/week-days/:user_id` | Array `{ date, hours }` lun–sáb |
| GET | `/all-users` | Admin: usuarios + teléfono + totales |

## Cómo probar

1. Configurar `DATABASE_URL` y `npm start`.
2. Abrir la app → ingresar teléfono + nombre (1ª vez) → ENTRAR.
3. Recargar: debe seguir logueado; si hay turno abierto, el timer continúa.
4. PRENDER → esperar → APAGAR → ver banner/alert “Estuviste X horas” y actualizar HOY/SEMANA.
5. Concedir notificaciones; con la app abierta, los recordatorios se evalúan cada minuto (hora La Paz).

## Estructura

- `server.js` — API + migración de `phone` + índices
- `index.html` — UI PWA
- `sw.js` — cache + notificaciones por mensaje
- `manifest.json` — metadatos PWA
- `package.json` — dependencias
