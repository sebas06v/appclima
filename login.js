/* AppClima — pantalla de acceso: iniciar sesión y crear cuenta. */

const TIMEOUT_MS = 12000;

const $ = (id) => document.getElementById(id);
const estado = $("auth-status");
const formLogin = $("form-login");
const formRegistro = $("form-registro");

/* ---------- Utilidades ---------- */

function mostrarEstado(msg, esError = false) {
  estado.textContent = msg;
  estado.classList.toggle("error", esError);
  estado.hidden = false;
}
function ocultarEstado() { estado.hidden = true; }

/** POST con timeout; traduce cualquier fallo a un mensaje entendible. */
async function enviar(url, cuerpo) {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: control.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("El servidor tardó demasiado. Inténtalo de nuevo.");
    throw new Error("No hay conexión con el servidor. Comprueba tu red e inténtalo de nuevo.");
  } finally {
    clearTimeout(temporizador);
  }

  const datos = await res.json().catch(() => null);
  if (!res.ok || (datos && datos.error)) {
    throw new Error((datos && datos.mensaje) || `El servidor respondió con un error (HTTP ${res.status}).`);
  }
  return datos;
}

function bloquearFormulario(form, bloqueado, textoOcupado) {
  const btn = form.querySelector("button[type=submit]");
  if (!btn.dataset.textoOriginal) btn.dataset.textoOriginal = btn.textContent;
  btn.disabled = bloqueado;
  btn.textContent = bloqueado ? textoOcupado : btn.dataset.textoOriginal;
  form.querySelectorAll("input").forEach((i) => { i.disabled = bloqueado; });
}

/* ---------- Pestañas ---------- */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const destino = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    formLogin.hidden = destino !== "login";
    formRegistro.hidden = destino !== "registro";
    ocultarEstado();
  });
});

/* ---------- Iniciar sesión ---------- */

formLogin.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;

  if (!email || !password) return mostrarEstado("Introduce tu correo y tu contraseña.", true);

  bloquearFormulario(formLogin, true, "Entrando…");
  mostrarEstado("Comprobando tus datos…");
  try {
    await enviar("/api/login", { email, password });
    mostrarEstado("Listo, entrando…");
    window.location.replace("/");
  } catch (e) {
    mostrarEstado(e.message, true);
    bloquearFormulario(formLogin, false);
    $("login-password").value = "";
    $("login-password").focus();
  }
});

/* ---------- Crear cuenta ---------- */

formRegistro.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const nombre = $("reg-nombre").value.trim();
  const email = $("reg-email").value.trim();
  const password = $("reg-password").value;

  // Validación en el cliente; el servidor la repite (nunca se confía solo en esta).
  if (nombre.length < 2) return mostrarEstado("El nombre debe tener al menos 2 caracteres.", true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return mostrarEstado("El correo no tiene un formato válido.", true);
  if (password.length < 8) return mostrarEstado("La contraseña debe tener al menos 8 caracteres.", true);

  bloquearFormulario(formRegistro, true, "Creando cuenta…");
  mostrarEstado("Creando tu cuenta…");
  try {
    await enviar("/api/registro", { nombre, email, password });
    // El correo de bienvenida sale por su cuenta en el servidor: no se espera aquí.
    mostrarEstado("¡Cuenta creada! Te enviamos un correo de bienvenida. Entrando…");
    window.location.replace("/");
  } catch (e) {
    mostrarEstado(e.message, true);
    bloquearFormulario(formRegistro, false);
  }
});

/* ---------- Arranque ---------- */

// Errores que vuelven del flujo de Google, en ?error=…
const errorUrl = new URLSearchParams(window.location.search).get("error");
if (errorUrl) {
  mostrarEstado(errorUrl, true);
  // Se limpia la URL para que el error no reaparezca al recargar.
  window.history.replaceState({}, "", window.location.pathname);
}

// Si ya hay sesión activa, no tiene sentido mostrar esta pantalla.
fetch("/api/sesion")
  .then((r) => { if (r.ok) window.location.replace("/"); })
  .catch(() => { /* sin conexión: se queda en el formulario */ });

// El botón de Google solo aparece si el servidor tiene credenciales configuradas.
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => { if (c.google) $("bloque-google").hidden = false; })
  .catch(() => { /* sin conexión: se queda solo el acceso con contraseña */ });
