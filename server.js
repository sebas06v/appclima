/*
 * AppClima — servidor: archivos estáticos + proxy hacia Open-Meteo.
 *
 * El navegador nunca llama a Open-Meteo directamente: pasa por /api/clima y
 * /api/geocode. Así la API key vive solo aquí (leída de .env) y jamás se envía
 * al cliente. Sin dependencias externas.
 *
 * Uso: node server.js  ->  http://localhost:3000
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

/* ---------- Variables de ambiente ---------- */
// Carga .env si existe (Node >= 20.12). La app funciona igual sin el archivo.
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path.join(__dirname, ".env"));
  }
} catch (e) {
  console.warn("No se encontró .env; se usan los valores por defecto.");
}

const PUERTO = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPEN_METEO_API_KEY || "";
const TIMEOUT_MS = Number(process.env.OPEN_METEO_TIMEOUT_MS || 10000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

// Con API key se usan los hosts comerciales de Open-Meteo; sin ella, los gratuitos.
const HOST_FORECAST = API_KEY ? "https://customer-api.open-meteo.com" : "https://api.open-meteo.com";
const HOST_GEO = API_KEY ? "https://customer-geocoding-api.open-meteo.com" : "https://geocoding-api.open-meteo.com";

/* ---------- Utilidades ---------- */

class ErrorAPI extends Error {
  constructor(mensaje, codigo, http = 502) {
    super(mensaje);
    this.codigo = codigo;
    this.http = http;
  }
}

const cache = new Map();

function deCache(clave) {
  const item = cache.get(clave);
  if (!item) return null;
  if (Date.now() > item.expira) { cache.delete(clave); return null; }
  return item.datos;
}

function aCache(clave, datos) {
  cache.set(clave, { datos, expira: Date.now() + CACHE_TTL_MS });
  // Poda simple para que el mapa no crezca sin límite.
  if (cache.size > 200) {
    for (const [k, v] of cache) if (Date.now() > v.expira) cache.delete(k);
  }
}

function enviarJSON(res, codigo, obj, extra = {}) {
  const cuerpo = JSON.stringify(obj);
  res.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(cuerpo);
}

function enviarError(res, err) {
  const e = err instanceof ErrorAPI ? err : new ErrorAPI("Error interno del servidor.", "INTERNO", 500);
  if (!(err instanceof ErrorAPI)) console.error("Error no controlado:", err);
  enviarJSON(res, e.http, { error: true, codigo: e.codigo, mensaje: e.message });
}

/** Llama a Open-Meteo con timeout y traduce cualquier fallo a un ErrorAPI legible. */
async function llamarOpenMeteo(url) {
  // La clave de caché se calcula antes de añadir la API key, para no guardarla.
  const clave = url.href;
  const enCache = deCache(clave);
  if (enCache) return { datos: enCache, cache: true };

  if (API_KEY) url.searchParams.set("apikey", API_KEY);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new ErrorAPI("Open-Meteo tardó demasiado en responder. Inténtalo de nuevo.", "TIMEOUT", 504);
    }
    throw new ErrorAPI("No se pudo conectar con Open-Meteo. Revisa la conexión del servidor.", "SIN_CONEXION", 502);
  }

  const datos = await res.json().catch(() => null);

  if (res.status === 429) {
    throw new ErrorAPI("Se alcanzó el límite de peticiones de Open-Meteo. Espera un momento.", "LIMITE", 429);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ErrorAPI("Open-Meteo rechazó la API key configurada.", "API_KEY_INVALIDA", 502);
  }
  if (!res.ok || (datos && datos.error)) {
    const motivo = (datos && datos.reason) || `respuesta HTTP ${res.status}`;
    // Open-Meteo responde 400 (no 401) cuando la key es inválida.
    if (/api key/i.test(motivo)) {
      throw new ErrorAPI("La API key configurada en .env no es válida.", "API_KEY_INVALIDA", 502);
    }
    throw new ErrorAPI(`Open-Meteo devolvió un error: ${motivo}`, "UPSTREAM", 502);
  }
  if (!datos) {
    throw new ErrorAPI("Open-Meteo devolvió una respuesta ilegible.", "RESPUESTA_INVALIDA", 502);
  }

  aCache(clave, datos);
  return { datos, cache: false };
}

function numeroEnRango(valor, min, max, nombre) {
  const n = Number(valor);
  if (valor === null || valor === "" || Number.isNaN(n)) {
    throw new ErrorAPI(`El parámetro "${nombre}" debe ser un número.`, "PARAMETRO_INVALIDO", 400);
  }
  if (n < min || n > max) {
    throw new ErrorAPI(`El parámetro "${nombre}" debe estar entre ${min} y ${max}.`, "FUERA_DE_RANGO", 400);
  }
  return n;
}

/* ---------- Endpoints ---------- */

async function rutaClima(params, res) {
  const lat = numeroEnRango(params.get("lat"), -90, 90, "lat");
  const lon = numeroEnRango(params.get("lon"), -180, 180, "lon");
  const unidad = params.get("unidad") === "fahrenheit" ? "fahrenheit" : "celsius";

  const url = new URL("/v1/forecast", HOST_FORECAST);
  Object.entries({
    latitude: lat,
    longitude: lon,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
    timezone: "auto",
    forecast_days: "7",
    temperature_unit: unidad,
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  const { datos, cache: fueCache } = await llamarOpenMeteo(url);
  enviarJSON(res, 200, datos, { "X-Cache": fueCache ? "HIT" : "MISS" });
}

async function rutaGeocode(params, res) {
  const q = (params.get("q") || "").trim();
  if (q.length < 2) {
    throw new ErrorAPI('El parámetro "q" debe tener al menos 2 caracteres.', "PARAMETRO_INVALIDO", 400);
  }

  const url = new URL("/v1/search", HOST_GEO);
  url.searchParams.set("name", q);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", "es");
  url.searchParams.set("format", "json");

  const { datos, cache: fueCache } = await llamarOpenMeteo(url);
  // Open-Meteo omite "results" cuando no hay coincidencias: se normaliza a lista vacía.
  enviarJSON(res, 200, { results: datos.results || [] }, { "X-Cache": fueCache ? "HIT" : "MISS" });
}

/* ---------- Archivos estáticos ---------- */

const RAIZ = __dirname;
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function servirEstatico(ruta, res) {
  const archivo = path.join(RAIZ, ruta === "/" ? "index.html" : ruta);
  if (!archivo.startsWith(RAIZ)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Prohibido");
    return;
  }
  fs.readFile(archivo, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("No encontrado");
      return;
    }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(archivo)] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ---------- Servidor ---------- */

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const ruta = decodeURIComponent(url.pathname);

  try {
    if (ruta.startsWith("/api/")) {
      if (req.method !== "GET") throw new ErrorAPI("Método no permitido.", "METODO", 405);
      if (ruta === "/api/clima") return await rutaClima(url.searchParams, res);
      if (ruta === "/api/geocode") return await rutaGeocode(url.searchParams, res);
      throw new ErrorAPI("Endpoint no encontrado.", "NO_ENCONTRADO", 404);
    }
    servirEstatico(ruta, res);
  } catch (e) {
    enviarError(res, e);
  }
}).listen(PUERTO, () => {
  console.log(`AppClima en http://localhost:${PUERTO}`);
  console.log(API_KEY
    ? "API key detectada: usando los endpoints comerciales de Open-Meteo."
    : "Sin API key (OPEN_METEO_API_KEY): usando los endpoints gratuitos de Open-Meteo.");
});
