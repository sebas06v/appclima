/* AppClima — frontend. Consume Open-Meteo (https://open-meteo.com/en/docs)
   a través del proxy propio expuesto en server.js. */

/* La app NO llama a Open-Meteo directamente: pasa por el proxy del servidor
   (server.js), que es quien guarda la API key en variables de ambiente. */
const API_CLIMA = "/api/clima";
const API_GEOCODE = "/api/geocode";
const TIMEOUT_MS = 12000;

// Códigos WMO usados por Open-Meteo -> [descripción, icono, tipo de fondo]
const WMO = {
  0:  ["Despejado", "☀️", "clear"],
  1:  ["Mayormente despejado", "🌤️", "clear"],
  2:  ["Parcialmente nublado", "⛅", "cloud"],
  3:  ["Nublado", "☁️", "cloud"],
  45: ["Niebla", "🌫️", "cloud"],
  48: ["Niebla con escarcha", "🌫️", "cloud"],
  51: ["Llovizna ligera", "🌦️", "rain"],
  53: ["Llovizna moderada", "🌦️", "rain"],
  55: ["Llovizna densa", "🌧️", "rain"],
  56: ["Llovizna helada ligera", "🌧️", "rain"],
  57: ["Llovizna helada densa", "🌧️", "rain"],
  61: ["Lluvia ligera", "🌦️", "rain"],
  63: ["Lluvia moderada", "🌧️", "rain"],
  65: ["Lluvia fuerte", "🌧️", "rain"],
  66: ["Lluvia helada ligera", "🌧️", "rain"],
  67: ["Lluvia helada fuerte", "🌧️", "rain"],
  71: ["Nevada ligera", "🌨️", "snow"],
  73: ["Nevada moderada", "🌨️", "snow"],
  75: ["Nevada fuerte", "❄️", "snow"],
  77: ["Granos de nieve", "🌨️", "snow"],
  80: ["Chubascos ligeros", "🌦️", "rain"],
  81: ["Chubascos moderados", "🌧️", "rain"],
  82: ["Chubascos violentos", "⛈️", "rain"],
  85: ["Chubascos de nieve", "🌨️", "snow"],
  86: ["Chubascos de nieve fuertes", "❄️", "snow"],
  95: ["Tormenta eléctrica", "⛈️", "storm"],
  96: ["Tormenta con granizo", "⛈️", "storm"],
  99: ["Tormenta con granizo fuerte", "⛈️", "storm"],
};

const FONDOS = {
  clear: "linear-gradient(160deg, #1d4ed8 0%, #0c2a6b 55%, #0b1220 100%)",
  cloud: "linear-gradient(160deg, #334155 0%, #1e293b 55%, #0b1220 100%)",
  rain:  "linear-gradient(160deg, #1e3a5f 0%, #172554 55%, #0b1220 100%)",
  snow:  "linear-gradient(160deg, #475569 0%, #1e293b 55%, #0b1220 100%)",
  storm: "linear-gradient(160deg, #312e81 0%, #1e1b4b 55%, #0b1220 100%)",
  noche: "linear-gradient(160deg, #0f172a 0%, #111827 55%, #030712 100%)",
};

const $ = (id) => document.getElementById(id);
const el = {
  q: $("q"), sug: $("suggestions"), status: $("status"), result: $("result"),
  bg: $("bg"), lat: $("lat"), lon: $("lon"),
};

let unidad = localStorage.getItem("appclima:unidad") || "celsius";
let ubicacion = null;      // { lat, lon, nombre }
let debounceId = null;
let indiceActivo = -1;
// Contadores para descartar respuestas que llegan tarde y ya no corresponden
// a lo último que pidió el usuario.
let peticionClima = 0;
let peticionBusqueda = 0;

/* ---------- Utilidades ---------- */

/** Pinta un mensaje en la barra de estado, con botón de reintentar opcional. */
function mostrarEstado(msg, esError = false, reintentar = null) {
  el.status.textContent = "";
  const texto = document.createElement("span");
  texto.textContent = msg;
  el.status.appendChild(texto);

  if (reintentar) {
    const btn = document.createElement("button");
    btn.className = "retry";
    btn.type = "button";
    btn.textContent = "Reintentar";
    btn.addEventListener("click", reintentar);
    el.status.appendChild(btn);
  }

  el.status.classList.toggle("error", esError);
  el.status.hidden = false;
}
function ocultarEstado() { el.status.hidden = true; }

/**
 * Pide JSON al backend con timeout y traduce cualquier fallo a un mensaje
 * entendible: nunca se muestra al usuario un error crudo del navegador.
 */
async function pedirJSON(url, timeoutMs = TIMEOUT_MS) {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, { signal: control.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("La consulta tardó demasiado. Revisa tu conexión e inténtalo de nuevo.");
    }
    throw new Error("No hay conexión con el servidor. Comprueba tu red e inténtalo de nuevo.");
  } finally {
    clearTimeout(temporizador);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    // El backend envía { error, codigo, mensaje } ya traducido.
    throw new Error((data && data.mensaje) || `El servidor respondió con un error (HTTP ${res.status}).`);
  }
  return data;
}

const info = (code) => WMO[code] || ["Desconocido", "❓", "cloud"];
const simUnidad = () => (unidad === "celsius" ? "°C" : "°F");
const redondea = (n) => (n === null || n === undefined ? "—" : Math.round(n));

function hora(iso) {
  return iso.slice(11, 16);
}
function nombreDia(iso, indice) {
  if (indice === 0) return "Hoy";
  if (indice === 1) return "Mañana";
  return new Date(iso + "T12:00:00").toLocaleDateString("es", { weekday: "long" });
}
function fechaCorta(iso) {
  return new Date(iso + "T12:00:00").toLocaleDateString("es", { day: "numeric", month: "short" });
}
function rumbo(grados) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
  return dirs[Math.round(grados / 22.5) % 16];
}

/* ---------- Geocodificación (buscar ciudad) ---------- */

async function buscarCiudades(nombre) {
  const data = await pedirJSON(`${API_GEOCODE}?q=${encodeURIComponent(nombre)}`);
  return data.results || [];
}

function pintarSugerencias(lista, termino = "") {
  indiceActivo = -1;

  // Sin coincidencias: se avisa en el desplegable en vez de dejarlo en blanco.
  if (!lista.length) {
    el.sug.innerHTML = `<li class="vacio">No encontramos ninguna ubicación para "${termino}". Revisa la ortografía o usa las coordenadas.</li>`;
    el.sug.hidden = false;
    return;
  }

  el.sug.innerHTML = lista.map((c, i) => {
    const detalle = [c.admin1, c.country].filter(Boolean).join(", ");
    return `<li data-i="${i}"><strong>${c.name}</strong> <span class="sub">${detalle} · ${c.latitude.toFixed(2)}, ${c.longitude.toFixed(2)}</span></li>`;
  }).join("");
  el.sug.hidden = false;
  el.sug.querySelectorAll("li[data-i]").forEach((li) => {
    li.addEventListener("click", () => elegirCiudad(lista[+li.dataset.i]));
  });
}

function elegirCiudad(c) {
  el.sug.hidden = true;
  el.q.value = c.name;
  const nombre = [c.name, c.admin1, c.country].filter(Boolean).join(", ");
  cargarClima({ lat: c.latitude, lon: c.longitude, nombre });
}

/* ---------- Pronóstico ---------- */

async function cargarClima(loc) {
  ubicacion = loc;
  localStorage.setItem("appclima:ubicacion", JSON.stringify(loc));
  mostrarEstado("Consultando el clima…");

  const miPeticion = ++peticionClima;
  const params = new URLSearchParams({ lat: loc.lat, lon: loc.lon, unidad });

  try {
    const data = await pedirJSON(`${API_CLIMA}?${params}`);
    if (miPeticion !== peticionClima) return;   // llegó tarde: ya hay otra consulta en curso
    pintarClima(data, loc);
    ocultarEstado();
    el.result.hidden = false;
  } catch (e) {
    if (miPeticion !== peticionClima) return;
    el.result.hidden = true;
    mostrarEstado(e.message, true, () => cargarClima(loc));
  }
}

function pintarClima(data, loc) {
  const c = data.current;
  const [desc, icono, tipo] = info(c.weather_code);

  $("place").textContent = loc.nombre || "Ubicación seleccionada";
  $("coords").textContent = `${(+loc.lat).toFixed(4)}, ${(+loc.lon).toFixed(4)} · ${data.timezone} (${data.elevation} m)`;
  $("updated").textContent = `Actualizado ${hora(c.time)}`;

  $("icon").textContent = icono;
  $("temp").textContent = `${redondea(c.temperature_2m)}${simUnidad()}`;
  $("desc").textContent = desc;
  $("feels").textContent = `Sensación térmica ${redondea(c.apparent_temperature)}${simUnidad()}`;

  $("m-hum").textContent = `${redondea(c.relative_humidity_2m)} %`;
  $("m-wind").textContent = `${redondea(c.wind_speed_10m)} km/h ${rumbo(c.wind_direction_10m)}`;
  $("m-gust").textContent = `${redondea(c.wind_gusts_10m)} km/h`;
  $("m-prec").textContent = `${c.precipitation ?? 0} mm`;
  $("m-press").textContent = `${redondea(c.surface_pressure)} hPa`;
  $("m-cloud").textContent = `${redondea(c.cloud_cover)} %`;
  $("m-sunrise").textContent = hora(data.daily.sunrise[0]);
  $("m-sunset").textContent = hora(data.daily.sunset[0]);

  el.bg.style.background = c.is_day ? FONDOS[tipo] : FONDOS.noche;

  pintarHoras(data);
  pintarDias(data);
}

/* Próximas 24 h a partir de la hora local actual del lugar consultado */
function proximasHoras(data, n = 24) {
  const t = data.hourly.time;
  const ahora = data.current.time.slice(0, 13) + ":00";
  let inicio = t.findIndex((h) => h >= ahora);
  if (inicio < 0) inicio = 0;
  const idx = [];
  for (let i = inicio; i < Math.min(inicio + n, t.length); i++) idx.push(i);
  return idx;
}

function pintarHoras(data) {
  const idx = proximasHoras(data);

  $("hourly").innerHTML = idx.map((i, k) => {
    const [, ico] = info(data.hourly.weather_code[i]);
    const prob = data.hourly.precipitation_probability[i];
    return `<div class="hour">
      <div class="h">${k === 0 ? "Ahora" : hora(data.hourly.time[i])}</div>
      <span class="i">${ico}</span>
      <div class="t">${redondea(data.hourly.temperature_2m[i])}${simUnidad()}</div>
      <div class="p">${prob != null ? prob + "%" : "&nbsp;"}</div>
    </div>`;
  }).join("");

  dibujarGrafico(
    idx.map((i) => data.hourly.temperature_2m[i]),
    idx.map((i) => hora(data.hourly.time[i]))
  );
}

function dibujarGrafico(temps, etiquetas) {
  const W = 960, H = 170, padX = 24, padTop = 28, padBottom = 26;
  const min = Math.min(...temps), max = Math.max(...temps);
  const span = max - min || 1;
  const x = (i) => padX + (i * (W - padX * 2)) / (temps.length - 1 || 1);
  const y = (v) => padTop + (1 - (v - min) / span) * (H - padTop - padBottom);

  const puntos = temps.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${padX},${H - padBottom} ${puntos} ${x(temps.length - 1).toFixed(1)},${H - padBottom}`;

  const marcas = temps.map((v, i) => {
    if (i % 3 !== 0) return "";
    return `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"/>
      <text class="val" x="${x(i).toFixed(1)}" y="${(y(v) - 9).toFixed(1)}" text-anchor="middle">${Math.round(v)}°</text>
      <text class="lbl" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${etiquetas[i]}</text>`;
  }).join("");

  $("chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperatura de las próximas 24 horas">
    <defs>
      <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line class="grid" x1="${padX}" y1="${H - padBottom}" x2="${W - padX}" y2="${H - padBottom}"/>
    <polygon class="area" points="${area}"/>
    <polyline class="line" points="${puntos}"/>
    ${marcas}
  </svg>`;
}

function pintarDias(data) {
  const d = data.daily;
  const minGlobal = Math.min(...d.temperature_2m_min);
  const maxGlobal = Math.max(...d.temperature_2m_max);
  const rango = maxGlobal - minGlobal || 1;

  $("daily").innerHTML = d.time.map((fecha, i) => {
    const [desc, ico] = info(d.weather_code[i]);
    const izq = ((d.temperature_2m_min[i] - minGlobal) / rango) * 100;
    const ancho = ((d.temperature_2m_max[i] - d.temperature_2m_min[i]) / rango) * 100;
    const prob = d.precipitation_probability_max[i];
    return `<div class="day" title="${desc} · lluvia ${d.precipitation_sum[i]} mm · viento máx ${redondea(d.wind_speed_10m_max[i])} km/h">
      <div class="name">${nombreDia(fecha, i)}<small>${fechaCorta(fecha)}${prob != null ? " 💧" + prob + "%" : ""}</small></div>
      <div class="ico">${ico}</div>
      <div class="bar"><span style="left:${izq}%;width:${Math.max(ancho, 3)}%"></span></div>
      <div class="range"><span class="min">${redondea(d.temperature_2m_min[i])}°</span> / <strong>${redondea(d.temperature_2m_max[i])}°</strong></div>
    </div>`;
  }).join("");
}

/* ---------- Eventos ---------- */

el.q.addEventListener("input", () => {
  clearTimeout(debounceId);
  const v = el.q.value.trim();
  if (v.length < 2) { el.sug.hidden = true; return; }
  debounceId = setTimeout(async () => {
    const miBusqueda = ++peticionBusqueda;
    try {
      const lista = await buscarCiudades(v);
      if (miBusqueda !== peticionBusqueda) return;  // el usuario ya escribió otra cosa
      pintarSugerencias(lista, v);
    } catch (e) {
      if (miBusqueda !== peticionBusqueda) return;
      el.sug.hidden = true;
      mostrarEstado(`No se pudo buscar la ubicación: ${e.message}`, true);
    }
  }, 300);
});

el.q.addEventListener("keydown", (ev) => {
  const items = [...el.sug.querySelectorAll("li[data-i]")];
  if (!items.length || el.sug.hidden) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    indiceActivo = (indiceActivo + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("active", i === indiceActivo));
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    (items[indiceActivo] || items[0]).click();
  } else if (ev.key === "Escape") {
    el.sug.hidden = true;
  }
});

document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".field.grow")) el.sug.hidden = true;
});

$("btn-geo").addEventListener("click", () => {
  if (!navigator.geolocation) return mostrarEstado("Tu navegador no soporta geolocalización.", true);
  mostrarEstado("Obteniendo tu ubicación…");
  navigator.geolocation.getCurrentPosition(
    (pos) => cargarClima({ lat: pos.coords.latitude, lon: pos.coords.longitude, nombre: "Mi ubicación" }),
    (err) => mostrarEstado(`No se pudo obtener la ubicación: ${err.message}`, true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$("btn-coords").addEventListener("click", () => {
  const lat = parseFloat(el.lat.value), lon = parseFloat(el.lon.value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return mostrarEstado("Introduce una latitud y longitud válidas.", true);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return mostrarEstado("Latitud entre -90 y 90; longitud entre -180 y 180.", true);
  cargarClima({ lat, lon, nombre: `Lat ${lat.toFixed(4)}, Lon ${lon.toFixed(4)}` });
});

document.querySelectorAll(".unit-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    unidad = btn.dataset.unit;
    localStorage.setItem("appclima:unidad", unidad);
    document.querySelectorAll(".unit-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    if (ubicacion) cargarClima(ubicacion);
  });
});

/* ---------- Arranque ---------- */

(function init() {
  document.querySelectorAll(".unit-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.unit === unidad));
  const guardada = localStorage.getItem("appclima:ubicacion");
  if (guardada) {
    try {
      const loc = JSON.parse(guardada);
      if (loc.nombre && loc.nombre !== "Mi ubicación") el.q.value = loc.nombre.split(",")[0];
      cargarClima(loc);
      return;
    } catch (e) { /* ubicación guardada corrupta: usar la de por defecto */ }
  }
  cargarClima({ lat: 4.6097, lon: -74.0817, nombre: "Bogotá, Colombia" });
})();
