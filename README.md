# ⛅ AppClima

Aplicación de clima que consume la [API de Open-Meteo](https://open-meteo.com/en/docs).
El usuario puede introducir latitud y longitud, buscar una ubicación por nombre o usar
la geolocalización del navegador.

Arquitectura **frontend + backend**: el navegador nunca llama a Open-Meteo directamente,
sino a un proxy propio, de modo que la API key vive únicamente en el servidor a través
de variables de ambiente.

```
navegador (index.html/app.js) → backend (server.js) → Open-Meteo
                                 └─ lee OPEN_METEO_API_KEY de .env
```

## Cómo ejecutarla

```bash
cp .env.example .env    # opcional: el plan gratuito de Open-Meteo no requiere key
npm start               # o: node server.js
```

Abre http://localhost:3000

Sin dependencias externas: solo Node.js (>= 20.12, por `process.loadEnvFile`).

## Variables de ambiente

Se definen en `.env`, que está en `.gitignore` y **nunca se sube al repositorio**.
La plantilla versionada es `.env.example`.

| Variable | Por defecto | Descripción |
|---|---|---|
| `OPEN_METEO_API_KEY` | *(vacía)* | API key de Open-Meteo. Si se define, el servidor usa los endpoints comerciales (`customer-api.open-meteo.com`) y añade el parámetro `apikey`. Si está vacía, usa los gratuitos. |
| `PORT` | `3000` | Puerto del servidor. |
| `OPEN_METEO_TIMEOUT_MS` | `10000` | Tiempo máximo de espera hacia Open-Meteo. |
| `CACHE_TTL_MS` | `600000` | Duración de la caché de respuestas (10 min). |

La key se lee con `process.env` en `server.js` y se adjunta a la petición **en el servidor**.
Nunca se envía al navegador, así que no es visible en el código fuente de la página.

## API del backend

| Endpoint | Parámetros | Descripción |
|---|---|---|
| `GET /api/clima` | `lat`, `lon`, `unidad` (`celsius`/`fahrenheit`) | Pronóstico actual, por hora (24 h) y de 7 días. |
| `GET /api/geocode` | `q` (mín. 2 caracteres) | Busca ubicaciones por nombre y devuelve sus coordenadas. |

Ambos validan la entrada, aplican caché y devuelven los errores con la forma:

```json
{ "error": true, "codigo": "FUERA_DE_RANGO", "mensaje": "El parámetro \"lat\" debe estar entre -90 y 90." }
```

## Manejo de errores

**En el backend** (`server.js`), cada fallo se traduce a un código y un mensaje en español:

| Situación | HTTP | Código |
|---|---|---|
| `lat`/`lon` no numéricos o ausentes | 400 | `PARAMETRO_INVALIDO` |
| `lat`/`lon` fuera de rango | 400 | `FUERA_DE_RANGO` |
| Open-Meteo no responde a tiempo | 504 | `TIMEOUT` |
| Sin conexión con Open-Meteo | 502 | `SIN_CONEXION` |
| Límite de peticiones alcanzado | 429 | `LIMITE` |
| API key rechazada | 502 | `API_KEY_INVALIDA` |
| Endpoint o método incorrectos | 404 / 405 | `NO_ENCONTRADO` / `METODO` |

**En el frontend** (`app.js`):

- `AbortController` con timeout de 12 s: ninguna consulta se queda colgada.
- Los errores crudos del navegador (`Failed to fetch`) nunca llegan a la interfaz; se
  sustituyen por mensajes explicativos.
- Botón **Reintentar** junto al mensaje de error.
- Búsqueda sin coincidencias: aviso explícito en el desplegable.
- Contadores de petición que descartan las respuestas que llegan tarde, para que una
  consulta antigua no pise a la más reciente.
- Validación de rangos en las coordenadas manuales y gestión de los errores de
  geolocalización (permiso denegado, no soportada, timeout).

## Funcionalidades

- **Buscar ubicación** con autocompletado (navegación con ↑ ↓ y Enter).
- **📍 Mi ubicación** mediante la geolocalización del navegador.
- **Coordenadas manuales** de latitud y longitud.
- **Clima actual**: temperatura, sensación térmica, humedad, viento y rumbo, ráfagas,
  precipitación, presión, nubosidad, amanecer y atardecer.
- **Próximas 24 h**: gráfico SVG de temperatura y tira por hora con probabilidad de lluvia.
- **7 días**: máximas y mínimas con barra de rango.
- Cambio entre **°C y °F**, fondo dinámico según el código WMO y si es de día o de noche,
  y última ubicación recordada en `localStorage`.

## Archivos

| Archivo | |
|---|---|
| `index.html` | estructura de la interfaz |
| `styles.css` | estilos |
| `app.js` | frontend: llamadas al backend y renderizado |
| `server.js` | backend: proxy a Open-Meteo, variables de ambiente, caché y errores |
| `.env.example` | plantilla de variables de ambiente |

Los `weather_code` son códigos WMO; la tabla de traducción está en la constante `WMO` de `app.js`.

---

Datos de [Open-Meteo.com](https://open-meteo.com/), licencia CC BY 4.0.
