# ⏱️ Control de Horas Laborales

Sistema simple y eficiente para registrar horas trabajadas del personal con geolocalización.

## Características

- **Registro por botón**: "Empezar" y "Detener"
- **Redondeo automático** cada 15 minutos **hacia abajo** (ej: 9:14 → 9:00)
- **Geolocalización** en cada registro (enlace directo a Google Maps)
- **Cálculo diario y semanal** (Lunes a Sábado)
- **Historial completo** con ubicación
- **Funciona en celular** (PWA - instalable)
- **Fácil de convertir a APK**

## Tecnologías

- **Backend**: Node.js + Express
- **Base de Datos**: Neon Postgres
- **Frontend**: HTML + Tailwind CSS + JavaScript
- **Despliegue**: Railway (recomendado)
- **Geolocalización**: Browser API

## Estructura del Proyecto

