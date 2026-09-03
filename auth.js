/*
 * AppClima — autenticación: usuarios, contraseñas y sesiones.
 *
 * Sin dependencias externas: usa el módulo crypto de Node.
 * - Contraseñas con scrypt + salt aleatorio por usuario (nunca en texto plano).
 * - Sesiones en cookie firmada con HMAC (httpOnly), sin estado en el servidor.
 */
const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const DIR_DATOS = path.join(__dirname, "data");
const ARCHIVO = path.join(DIR_DATOS, "usuarios.json");

const DURACION_SESION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

/* ---------- Almacén de usuarios (archivo JSON) ---------- */

let usuarios = null; // Map<email, usuario>

function cargar() {
  if (usuarios) return usuarios;
  usuarios = new Map();
  try {
    const lista = JSON.parse(fsSync.readFileSync(ARCHIVO, "utf8"));
    for (const u of lista) usuarios.set(u.email, u);
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("No se pudo leer usuarios.json:", e.message);
  }
  return usuarios;
}

async function persistir() {
  await fs.mkdir(DIR_DATOS, { recursive: true });
  await fs.writeFile(ARCHIVO, JSON.stringify([...cargar().values()], null, 2), "utf8");
}

/* ---------- Contraseñas ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verificarPassword(password, guardado) {
  try {
    const [saltHex, hashHex] = String(guardado).split(":");
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
    // timingSafeEqual evita filtrar información por el tiempo de comparación.
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
  } catch (e) {
    return false;
  }
}

/* ---------- Validación ---------- */

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validarRegistro({ nombre, email, password }) {
  const errores = [];
  if (!nombre || String(nombre).trim().length < 2) errores.push("El nombre debe tener al menos 2 caracteres.");
  if (!email || !RE_EMAIL.test(String(email).trim())) errores.push("El correo no tiene un formato válido.");
  if (!password || String(password).length < 8) errores.push("La contraseña debe tener al menos 8 caracteres.");
  return errores;
}

/* ---------- Usuarios ---------- */

function buscarPorEmail(email) {
  return cargar().get(String(email || "").trim().toLowerCase()) || null;
}

async function crearUsuario({ nombre, email, password }) {
  const correo = String(email).trim().toLowerCase();
  const usuario = {
    id: crypto.randomUUID(),
    nombre: String(nombre).trim(),
    email: correo,
    password: hashPassword(password),
    creado: new Date().toISOString(),
  };
  cargar().set(correo, usuario);
  await persistir();
  return usuario;
}

/** Datos del usuario seguros para enviar al navegador (sin el hash). */
function publico(u) {
  return { id: u.id, nombre: u.nombre, email: u.email, creado: u.creado };
}

/* ---------- Sesiones (cookie firmada) ---------- */

function secreto() {
  return process.env.SESSION_SECRET || secreto._temporal || (secreto._temporal = crypto.randomBytes(32).toString("hex"));
}

function firmar(datos) {
  return crypto.createHmac("sha256", secreto()).update(datos).digest("base64url");
}

/** Devuelve el valor de la cookie: "email.expiracion.firma" */
function crearSesion(usuario) {
  const cuerpo = `${Buffer.from(usuario.email).toString("base64url")}.${Date.now() + DURACION_SESION_MS}`;
  return `${cuerpo}.${firmar(cuerpo)}`;
}

function verificarSesion(valor) {
  if (!valor) return null;
  const partes = String(valor).split(".");
  if (partes.length !== 3) return null;

  const [emailB64, expira, firma] = partes;
  const cuerpo = `${emailB64}.${expira}`;

  const esperada = Buffer.from(firmar(cuerpo));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
  if (Date.now() > Number(expira)) return null;

  return buscarPorEmail(Buffer.from(emailB64, "base64url").toString("utf8"));
}

function leerCookies(cabecera) {
  const out = {};
  for (const par of String(cabecera || "").split(";")) {
    const i = par.indexOf("=");
    if (i > 0) out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return out;
}

function usuarioDePeticion(req) {
  return verificarSesion(leerCookies(req.headers.cookie).sesion);
}

function cookieSesion(valor, maxEdadSeg) {
  const partes = [`sesion=${valor}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxEdadSeg}`];
  if (process.env.COOKIE_SECURE === "true") partes.push("Secure");
  return partes.join("; ");
}

/* ---------- Límite de intentos de acceso ---------- */

const intentos = new Map();

function bloqueado(clave) {
  const reg = intentos.get(clave);
  if (!reg) return 0;
  if (Date.now() > reg.hasta) { intentos.delete(clave); return 0; }
  return reg.fallos >= MAX_INTENTOS ? Math.ceil((reg.hasta - Date.now()) / 60000) : 0;
}

function registrarFallo(clave) {
  const reg = intentos.get(clave) || { fallos: 0, hasta: 0 };
  reg.fallos += 1;
  reg.hasta = Date.now() + BLOQUEO_MS;
  intentos.set(clave, reg);
}

function limpiarIntentos(clave) {
  intentos.delete(clave);
}

module.exports = {
  validarRegistro, buscarPorEmail, crearUsuario, verificarPassword, publico,
  crearSesion, usuarioDePeticion, cookieSesion,
  bloqueado, registrarFallo, limpiarIntentos,
  DURACION_SESION_MS,
};
