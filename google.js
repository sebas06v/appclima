/*
 * AppClima — inicio de sesión con Google (OAuth 2.0, flujo de código de autorización).
 *
 * Todo el intercambio ocurre en el servidor: el navegador nunca ve el
 * GOOGLE_CLIENT_SECRET. Sin dependencias externas.
 *
 * Flujo:
 *   1. /api/auth/google           -> redirige a Google con un "state" antifalsificación
 *   2. Google pide permiso al usuario
 *   3. /api/auth/google/callback  -> se canjea el código por un id_token y se lee el perfil
 */
const AUTORIZACION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function config() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/auth/google/callback",
    timeout: Number(process.env.GOOGLE_TIMEOUT_MS || 10000),
  };
}

/** ¿Están configuradas las credenciales? La app funciona igual sin ellas. */
function configurado() {
  const { clientId, clientSecret } = config();
  return Boolean(clientId && clientSecret);
}

/** URL a la que se manda al usuario para que Google le pida permiso. */
function urlAutorizacion(estado) {
  const { clientId, redirectUri } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: estado,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTORIZACION_URL}?${params}`;
}

/** Decodifica el payload de un JWT. No valida la firma: no hace falta, ver abajo. */
function leerPayloadJWT(idToken) {
  const partes = String(idToken).split(".");
  if (partes.length !== 3) throw new Error("Google devolvió un id_token con formato inesperado.");
  return JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
}

/**
 * Canjea el código de autorización por el perfil del usuario.
 *
 * El id_token llega directamente de Google por HTTPS, a cambio de nuestro
 * client_secret. Al no pasar por el navegador no puede haber sido manipulado,
 * así que basta con leerlo (es lo que documenta Google para este flujo).
 */
async function intercambiarCodigo(codigo) {
  const { clientId, clientSecret, redirectUri, timeout } = config();

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: codigo,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error("Google tardó demasiado en responder. Inténtalo de nuevo.");
    }
    throw new Error("No se pudo conectar con Google. Inténtalo de nuevo.");
  }

  const datos = await res.json().catch(() => null);

  if (!res.ok || !datos || !datos.id_token) {
    const motivo = (datos && (datos.error_description || datos.error)) || `HTTP ${res.status}`;
    throw new Error(`Google rechazó la autenticación: ${motivo}`);
  }

  const perfil = leerPayloadJWT(datos.id_token);

  // Comprobaciones básicas del token: que sea para esta app y que no haya caducado.
  if (perfil.aud !== clientId) throw new Error("El token de Google no corresponde a esta aplicación.");
  if (perfil.exp && Date.now() / 1000 > perfil.exp) throw new Error("El token de Google ya caducó. Inténtalo de nuevo.");
  if (!perfil.email) throw new Error("Google no compartió una dirección de correo.");
  if (perfil.email_verified === false) throw new Error("Tu correo de Google no está verificado.");

  return {
    googleId: perfil.sub,
    email: String(perfil.email).toLowerCase(),
    nombre: perfil.name || perfil.given_name || String(perfil.email).split("@")[0],
  };
}

module.exports = { configurado, urlAutorizacion, intercambiarCodigo };
