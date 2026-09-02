# ⛅ AppClima

App web de clima que consulta la [API de Open-Meteo](https://open-meteo.com/en/docs) por latitud y longitud.
Sin dependencias, sin build y sin API key.

## Cómo ejecutarla

```bash
npm start          # o: node server.js
```

Luego abre http://localhost:3000

También puedes abrir `index.html` directamente en el navegador (la API permite CORS),
aunque servirla por HTTP es mejor: la geolocalización del navegador solo funciona en
`localhost` o HTTPS.

## Qué hace

- **Buscar ciudad** con autocompletado (API de geocodificación de Open-Meteo) → obtiene lat/lon.
- **📍 Mi ubicación**: usa la geolocalización del navegador.
- **Coordenadas manuales**: introduce latitud y longitud directamente.
- **Clima actual**: temperatura, sensación térmica, humedad, viento y rumbo, ráfagas,
  precipitación, presión, nubosidad, amanecer y atardecer.
- **Próximas 24 h**: gráfico SVG de temperatura + tira por hora con icono y probabilidad de lluvia.
- **7 días**: máx/mín con barra de rango, icono e indicador de lluvia.
- Cambio entre **°C y °F**, fondo que cambia según el clima y la hora, y la última
  ubicación se recuerda en `localStorage`.

## Endpoints usados

**Pronóstico** — `https://api.open-meteo.com/v1/forecast`

| Parámetro | Valor |
|---|---|
| `latitude` / `longitude` | coordenadas del lugar |
| `current` | `temperature_2m, relative_humidity_2m, apparent_temperature, is_day, precipitation, weather_code, cloud_cover, surface_pressure, wind_speed_10m, wind_direction_10m, wind_gusts_10m` |
| `hourly` | `temperature_2m, precipitation_probability, weather_code` |
| `daily` | `weather_code, temperature_2m_max, temperature_2m_min, sunrise, sunset, precipitation_sum, precipitation_probability_max, wind_speed_10m_max` |
| `timezone` | `auto` (todas las horas llegan en hora local del lugar) |
| `forecast_days` | `7` |
| `temperature_unit` | `celsius` / `fahrenheit` |

**Geocodificación** — `https://geocoding-api.open-meteo.com/v1/search?name=...&count=8&language=es&format=json`

Los `weather_code` son códigos WMO; la tabla de traducción está en `WMO` dentro de `app.js`.

## Archivos

- `index.html` — estructura de la interfaz
- `styles.css` — estilos
- `app.js` — llamadas a la API y renderizado
- `server.js` — servidor estático mínimo (solo Node, sin dependencias)

Datos de [Open-Meteo.com](https://open-meteo.com/), licencia CC BY 4.0. Uso no comercial gratuito sin clave.
