/**
 * Helpers de zona horaria para SQL.
 *
 * Las columnas time_entries.start_time / end_time son TIMESTAMP *sin* zona y
 * guardan la hora de pared UTC (se insertan con NOW() AT TIME ZONE 'UTC' o con
 * ISO '...Z'; Neon/Railway corren en UTC).
 *
 * OJO: `start_time AT TIME ZONE 'America/La_Paz'` sobre un TIMESTAMP sin zona
 * interpreta el valor como hora de La Paz y lo pasa a UTC (suma 4 h) — al
 * revés de lo que queremos. Lo correcto es declarar primero que es UTC y
 * recién después convertir a La Paz.
 */
const TZ = 'America/La_Paz';

/** Expresión SQL con la hora de pared La Paz (TIMESTAMP sin zona) de una columna UTC. */
function laPazWall(col) {
  return `((${col} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')`;
}

/** Fecha (DATE) La Paz de una columna UTC. */
function laPazDate(col) {
  return `${laPazWall(col)}::date`;
}

/** Día La Paz de un turno: columna `date` (guardada al prender) o, si falta, start_time convertido. */
function entryDay(alias = 'te') {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(${p}date, ${laPazDate(`${p}start_time`)})`;
}

module.exports = { TZ, laPazWall, laPazDate, entryDay };
