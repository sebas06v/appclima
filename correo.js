/*
 * AppClima — envío de correo.
 *
 * Tres proveedores, elegidos automáticamente según las variables de ambiente.
 * Ninguna credencial se escribe nunca en el código.
 *
 *   gmail    GMAIL_USER + GMAIL_APP_PASSWORD  -> SMTP de Gmail (nodemailer).
 *                                                Envía a CUALQUIER destinatario.
 *   resend   RESEND_API_KEY                   -> API de Resend. Con el remitente
 *                                                de pruebas onboarding@resend.dev
 *                                                solo entrega a tu propia cuenta;
 *                                                para escribir a cualquiera hay
 *                                                que verificar un dominio.
 *   consola  (nada configurado)               -> el mensaje se imprime en el log.
 *                                                La app funciona igual.
 *
 * Se puede forzar uno con MAIL_PROVIDER=gmail|resend|consola.
 */
const nodemailer = require("nodemailer");

const RESEND_URL = "https://api.resend.com/emails";
const INTENTOS = 3;
const ESPERA_BASE_MS = 500;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function config() {
  const gmailUser = process.env.GMAIL_USER || "";
  return {
    apiKey: process.env.RESEND_API_KEY || "",
    gmailUser,
    gmailPass: (process.env.GMAIL_APP_PASSWORD || "").replace(/\s/g, ""),
    // Gmail reescribe el remitente a la cuenta autenticada, así que se usa esa.
    remitente: process.env.MAIL_FROM || (gmailUser ? `AppClima <${gmailUser}>` : "AppClima <onboarding@resend.dev>"),
    urlApp: process.env.APP_URL || "http://localhost:3000",
    timeout: Number(process.env.MAIL_TIMEOUT_MS || 10000),
  };
}

function proveedor() {
  const forzado = (process.env.MAIL_PROVIDER || "").trim().toLowerCase();
  if (forzado) return forzado;

  const { gmailUser, gmailPass, apiKey } = config();
  if (gmailUser && gmailPass) return "gmail";
  if (apiKey) return "resend";
  return "consola";
}

/* ---------- Plantilla del correo de bienvenida ---------- */

function plantillaBienvenida(usuario) {
  const { urlApp } = config();
  const nombre = usuario.nombre;

  const asunto = "Bienvenido a AppClima ⛅ — tu cuenta ya está activa";

  const texto = [
    `Hola ${nombre},`,
    "",
    "Tu cuenta en AppClima se creó correctamente.",
    "",
    "Ya puedes consultar el clima de cualquier punto del planeta: busca una ciudad,",
    "usa tu ubicación o introduce directamente la latitud y la longitud.",
    "",
    `Entra aquí: ${urlApp}`,
    "",
    `Registrado con: ${usuario.email}`,
    "",
    "Si no fuiste tú quien creó esta cuenta, puedes ignorar este mensaje.",
    "",
    "— El equipo de AppClima",
  ].join("\n");

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#0f172a;font-family:'Segoe UI',system-ui,sans-serif;color:#f1f5f9;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#16233c;border-radius:16px;overflow:hidden;">
      <tr>
        <td style="padding:32px 32px 8px;">
          <p style="margin:0;font-size:40px;line-height:1;">⛅</p>
          <h1 style="margin:16px 0 0;font-size:24px;font-weight:600;">Bienvenido a AppClima, ${nombre}</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 32px 24px;">
          <p style="margin:16px 0;font-size:15px;line-height:1.6;color:#cbd5e1;">
            Tu cuenta se creó correctamente. Ya puedes consultar el clima de cualquier punto
            del planeta: busca una ciudad, usa tu ubicación o introduce directamente la
            latitud y la longitud.
          </p>
          <p style="margin:24px 0;">
            <a href="${urlApp}" style="display:inline-block;background:#7dd3fc;color:#0b1220;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;font-size:15px;">
              Abrir AppClima
            </a>
          </p>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#94a3b8;border-top:1px solid #2a3a55;padding-top:16px;">
            Cuenta registrada con <strong style="color:#cbd5e1;">${usuario.email}</strong>.<br />
            Si no fuiste tú quien creó esta cuenta, puedes ignorar este mensaje.
          </p>
        </td>
      </tr>
    </table>
    <p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#64748b;text-align:center;">
      AppClima · datos meteorológicos de Open-Meteo.com
    </p>
  </body>
</html>`;

  return { asunto, texto, html };
}

/* ---------- Envío ---------- */

async function enviarConResend({ para, asunto, texto, html }) {
  const { apiKey, remitente, timeout } = config();

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: remitente, to: [para], subject: asunto, html, text: texto }),
    signal: AbortSignal.timeout(timeout),
  });

  const datos = await res.json().catch(() => null);

  if (!res.ok) {
    const motivo = (datos && (datos.message || datos.name)) || `HTTP ${res.status}`;
    const err = new Error(`Resend rechazó el envío: ${motivo}`);
    // 4xx (salvo 429) son errores de configuración: reintentar no sirve de nada.
    err.reintentable = res.status === 429 || res.status >= 500;
    throw err;
  }

  return { id: datos && datos.id, proveedor: "resend" };
}

/* Transporte SMTP de Gmail, creado una sola vez y reutilizado. */
let transporteGmail = null;

function obtenerTransporteGmail() {
  const { gmailUser, gmailPass, timeout } = config();
  if (!transporteGmail) {
    transporteGmail = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass },
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
  }
  return transporteGmail;
}

async function enviarConGmail({ para, asunto, texto, html }) {
  const { remitente } = config();

  try {
    const info = await obtenerTransporteGmail().sendMail({
      from: remitente, to: para, subject: asunto, text: texto, html,
    });
    return { id: info.messageId, proveedor: "gmail" };
  } catch (e) {
    // Credenciales mal puestas: reintentar no arregla nada.
    if (e.code === "EAUTH") {
      const err = new Error(
        "Gmail rechazó las credenciales. Revisa GMAIL_USER y que GMAIL_APP_PASSWORD " +
        "sea una contraseña de aplicación de 16 caracteres (no la contraseña normal de tu cuenta)."
      );
      err.reintentable = false;
      throw err;
    }
    // Fallos de red o de conexión: sí merece la pena reintentar.
    const err = new Error(`No se pudo enviar por Gmail: ${e.message}`);
    err.reintentable = true;
    throw err;
  }
}

function enviarPorConsola({ para, asunto, texto }) {
  const { remitente } = config();
  console.log("┌─ CORREO (proveedor: consola — no se envió de verdad) ───────────");
  console.log(`│ De:      ${remitente}`);
  console.log(`│ Para:    ${para}`);
  console.log(`│ Asunto:  ${asunto}`);
  console.log("├─────────────────────────────────────────────────────────────────");
  texto.split("\n").forEach((l) => console.log(`│ ${l}`));
  console.log("└─ Define RESEND_API_KEY en .env para enviarlo de verdad ─────────");
  return { id: "consola", proveedor: "consola" };
}

/** Envía un correo con reintentos. Lanza el error si agota los intentos. */
async function enviar(mensaje) {
  const cual = proveedor();
  if (cual === "consola") return enviarPorConsola(mensaje);

  const enviarCon = cual === "gmail" ? enviarConGmail : enviarConResend;

  let ultimo;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      return await enviarCon(mensaje);
    } catch (e) {
      ultimo = e;
      const esUltimo = intento === INTENTOS;
      if (e.reintentable === false || esUltimo) break;
      console.warn(`[correo] intento ${intento}/${INTENTOS} falló: ${e.message}. Reintentando…`);
      await espera(ESPERA_BASE_MS * 2 ** (intento - 1));
    }
  }
  throw ultimo;
}

/**
 * Correo de bienvenida tras el registro.
 *
 * IMPORTANTE: se llama SIN await desde la ruta de registro. La respuesta al
 * usuario no espera al proveedor de correo; si el envío falla, se registra en
 * el log pero la cuenta ya quedó creada.
 */
function enviarBienvenida(usuario) {
  const { asunto, texto, html } = plantillaBienvenida(usuario);
  const inicio = Date.now();

  return enviar({ para: usuario.email, asunto, texto, html })
    .then((r) => {
      console.log(`[correo] bienvenida enviada a ${usuario.email} vía ${r.proveedor} (id: ${r.id}) en ${Date.now() - inicio} ms`);
      return r;
    })
    .catch((e) => {
      // No se propaga: el registro ya se completó y no debe verse afectado.
      console.error(`[correo] FALLÓ el envío de bienvenida a ${usuario.email}: ${e.message}`);
      return { error: e.message };
    });
}

module.exports = { enviarBienvenida, plantillaBienvenida, enviar, proveedor };
