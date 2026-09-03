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
const crypto = require("crypto");
const auth = require("./auth");
const correo = require("./correo");
const google = require("./google");

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

/** Lee y parsea el cuerpo JSON de una petición, con límite de tamaño. */
function leerCuerpo(req, maxBytes = 10_000) {
  return new Promise((resolve, reject) => {
    let datos = "";
    req.on("data", (trozo) => {
      datos += trozo;
      if (datos.length > maxBytes) {
        req.destroy();
        reject(new ErrorAPI("El cuerpo de la petición es demasiado grande.", "CUERPO_GRANDE", 413));
      }
    });
    req.on("end", () => {
      if (!datos) return resolve({});
      try {
        resolve(JSON.parse(datos));
      } catch (e) {
        reject(new ErrorAPI("El cuerpo de la petición no es JSON válido.", "JSON_INVALIDO", 400));
      }
    });
    req.on("error", () => reject(new ErrorAPI("Error al leer la petición.", "LECTURA", 400)));
  });
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

/* ---------- Endpoints: autenticación ---------- */

/** Lanza 401 si la petición no trae una sesión válida. */
function exigirSesion(req) {
  const usuario = auth.usuarioDePeticion(req);
  if (!usuario) {
    throw new ErrorAPI("Necesitas iniciar sesión para consultar el clima.", "NO_AUTENTICADO", 401);
  }
  return usuario;
}

async function rutaRegistro(req, res) {
  const cuerpo = await leerCuerpo(req);

  const errores = auth.validarRegistro(cuerpo);
  if (errores.length) {
    throw new ErrorAPI(errores.join(" "), "DATOS_INVALIDOS", 400);
  }
  if (auth.buscarPorEmail(cuerpo.email)) {
    throw new ErrorAPI("Ya existe una cuenta con ese correo. Inicia sesión.", "EMAIL_DUPLICADO", 409);
  }

  // 1) Se crea la cuenta y se persiste ANTES de responder.
  const usuario = await auth.crearUsuario(cuerpo);

  // 2) Se responde de inmediato: el usuario ya queda con sesión iniciada.
  const cookie = auth.cookieSesion(auth.crearSesion(usuario), auth.DURACION_SESION_MS / 1000);
  enviarJSON(res, 201, { usuario: auth.publico(usuario) }, { "Set-Cookie": cookie });

  // 3) El correo de bienvenida sale DESPUÉS de responder y SIN await: es una
  //    reacción al registro completado, y su latencia no afecta al usuario.
  //    Si falla, correo.js lo registra en el log y la cuenta sigue creada.
  setImmediate(() => { correo.enviarBienvenida(auth.publico(usuario)); });
}

async function rutaLogin(req, res) {
  const cuerpo = await leerCuerpo(req);
  const email = String(cuerpo.email || "").trim().toLowerCase();
  const clave = `login:${email}`;

  const minutos = auth.bloqueado(clave);
  if (minutos) {
    throw new ErrorAPI(`Demasiados intentos fallidos. Inténtalo en ${minutos} minuto(s).`, "BLOQUEADO", 429);
  }

  const usuario = auth.buscarPorEmail(email);

  // Cuenta creada con Google: no tiene contraseña que comprobar.
  if (usuario && !usuario.password) {
    throw new ErrorAPI('Esta cuenta se creó con Google. Usa el botón "Continuar con Google".', "USAR_GOOGLE", 409);
  }

  // Mensaje idéntico exista o no la cuenta: no se revela qué correos están registrados.
  if (!usuario || !auth.verificarPassword(String(cuerpo.password || ""), usuario.password)) {
    auth.registrarFallo(clave);
    throw new ErrorAPI("Correo o contraseña incorrectos.", "CREDENCIALES", 401);
  }

  auth.limpiarIntentos(clave);
  const cookie = auth.cookieSesion(auth.crearSesion(usuario), auth.DURACION_SESION_MS / 1000);
  enviarJSON(res, 200, { usuario: auth.publico(usuario) }, { "Set-Cookie": cookie });
}

function rutaLogout(res) {
  enviarJSON(res, 200, { ok: true }, { "Set-Cookie": auth.cookieSesion("", 0) });
}

function rutaSesion(req, res) {
  const usuario = auth.usuarioDePeticion(req);
  if (!usuario) throw new ErrorAPI("No hay sesión activa.", "NO_AUTENTICADO", 401);
  enviarJSON(res, 200, { usuario: auth.publico(usuario) });
}

/* ---------- Endpoints: acceso con Google (OAuth 2.0) ---------- */

function redirigir(res, destino, cookies = null) {
  const cabeceras = { Location: destino };
  if (cookies) cabeceras["Set-Cookie"] = cookies;
  res.writeHead(302, cabeceras);
  res.end();
}

/** Los errores de OAuth vuelven a la pantalla de acceso, no en JSON crudo. */
function redirigirLogin(res, mensaje) {
  redirigir(res, `/login.html?error=${encodeURIComponent(mensaje)}`, auth.cookie("oauth_estado", "", 0));
}

/** Paso 1: manda al usuario a Google con un "state" contra CSRF. */
function rutaGoogleInicio(req, res) {
  if (!google.configurado()) {
    return redirigirLogin(res, "El acceso con Google no está configurado en el servidor.");
  }
  const estado = crypto.randomBytes(32).toString("hex");
  redirigir(res, google.urlAutorizacion(estado), auth.cookie("oauth_estado", estado, 600));
}

/** Paso 2: Google devuelve el código; se canjea y se abre la sesión. */
async function rutaGoogleCallback(req, url, res) {
  const errorGoogle = url.searchParams.get("error");
  if (errorGoogle) {
    return redirigirLogin(res, errorGoogle === "access_denied"
      ? "Cancelaste el acceso con Google."
      : `Google devolvió un error: ${errorGoogle}`);
  }

  // El "state" recibido debe coincidir con el que guardamos en la cookie.
  const estadoRecibido = url.searchParams.get("state");
  const estadoCookie = auth.leerCookies(req.headers.cookie).oauth_estado;
  if (!estadoRecibido || !estadoCookie || estadoRecibido !== estadoCookie) {
    return redirigirLogin(res, "La verificación de seguridad con Google falló. Inténtalo de nuevo.");
  }

  const codigo = url.searchParams.get("code");
  if (!codigo) return redirigirLogin(res, "Google no devolvió el código de autorización.");

  let perfil;
  try {
    perfil = await google.intercambiarCodigo(codigo);
  } catch (e) {
    return redirigirLogin(res, e.message);
  }

  // ¿Ya existía esa cuenta? Si sí, se entra; si no, es un registro nuevo.
  let usuario = auth.buscarPorEmail(perfil.email);
  const esRegistroNuevo = !usuario;

  if (usuario) {
    await auth.vincularGoogle(usuario, perfil.googleId);
  } else {
    usuario = await auth.crearUsuario({
      nombre: perfil.nombre,
      email: perfil.email,
      proveedor: "google",
      googleId: perfil.googleId,
    });
  }

  redirigir(res, "/", [
    auth.cookieSesion(auth.crearSesion(usuario), auth.DURACION_SESION_MS / 1000),
    auth.cookie("oauth_estado", "", 0),
  ]);

  // Mismo criterio que el registro con contraseña: el correo de bienvenida sale
  // después de responder, sin await, y SOLO la primera vez que entra la cuenta.
  if (esRegistroNuevo) {
    setImmediate(() => { correo.enviarBienvenida(auth.publico(usuario)); });
  }
}

/** Le dice al frontend qué métodos de acceso están disponibles. */
function rutaConfig(res) {
  enviarJSON(res, 200, { google: google.configurado() });
}

/* ---------- Endpoints: clima ---------- */

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

// Método permitido por endpoint: sirve para distinguir un 404 de un 405.
const RUTAS = {
  "/api/registro": "POST",
  "/api/login": "POST",
  "/api/logout": "POST",
  "/api/sesion": "GET",
  "/api/config": "GET",
  "/api/auth/google": "GET",
  "/api/auth/google/callback": "GET",
  "/api/clima": "GET",
  "/api/geocode": "GET",
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const ruta = decodeURIComponent(url.pathname);

  try {
    if (ruta.startsWith("/api/")) {
      const metodo = RUTAS[ruta];
      if (!metodo) throw new ErrorAPI("Endpoint no encontrado.", "NO_ENCONTRADO", 404);
      if (metodo !== req.method) throw new ErrorAPI("Método no permitido.", "METODO", 405);

      switch (ruta) {
        case "/api/registro": return await rutaRegistro(req, res);
        case "/api/login":    return await rutaLogin(req, res);
        case "/api/logout":   return rutaLogout(res);
        case "/api/sesion":   return rutaSesion(req, res);
        case "/api/config":   return rutaConfig(res);
        case "/api/auth/google":          return rutaGoogleInicio(req, res);
        case "/api/auth/google/callback": return await rutaGoogleCallback(req, url, res);
        // El clima queda detrás del login.
        case "/api/clima":    exigirSesion(req); return await rutaClima(url.searchParams, res);
        case "/api/geocode":  exigirSesion(req); return await rutaGeocode(url.searchParams, res);
      }
    }
    servirEstatico(ruta, res);
  } catch (e) {
    enviarError(res, e);
  }
}).listen(PUERTO, () => {
  console.log(`AppClima en http://localhost:${PUERTO}`);
  console.log(API_KEY
    ? "Open-Meteo: API key detectada, usando los endpoints comerciales."
    : "Open-Meteo: sin API key (OPEN_METEO_API_KEY), usando los endpoints gratuitos.");
  console.log(correo.proveedor() === "resend"
    ? `Correo: Resend activo, remitente ${process.env.MAIL_FROM || "AppClima <onboarding@resend.dev>"}.`
    : "Correo: sin RESEND_API_KEY, los mensajes se imprimen en este log en vez de enviarse.");
  console.log(google.configurado()
    ? "Google: acceso con Google activo."
    : "Google: sin GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, el botón de Google queda oculto.");
  if (!process.env.SESSION_SECRET) {
    console.warn("Aviso: SESSION_SECRET no definido; se generó uno temporal (las sesiones caducan al reiniciar).");
  }
});
