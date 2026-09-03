# ⛅ AppClima

Aplicación de clima que consume la [API de Open-Meteo](https://open-meteo.com/en/docs),
con **registro e inicio de sesión** (contraseña o **cuenta de Google**) y **correo de
bienvenida automático**.

El usuario puede introducir latitud y longitud, buscar una ubicación por nombre o usar
la geolocalización del navegador.

Arquitectura **frontend + backend**: el navegador nunca llama a servicios externos
directamente, así que las credenciales viven únicamente en el servidor, en variables de ambiente.

```
navegador  →  backend (server.js)  →  Open-Meteo      (clima)
                    │                └─ OPEN_METEO_API_KEY
                    ├──────────────→  Gmail SMTP      (correo de bienvenida)
                    │                 └─ GMAIL_APP_PASSWORD   (o Resend)
                    └──────────────→  Google OAuth    (acceso con Google)
                                      └─ GOOGLE_CLIENT_SECRET
```

## Cómo ejecutarla

```bash
cp .env.example .env    # y rellena SESSION_SECRET y RESEND_API_KEY
npm start               # o: node server.js
```

Abre http://localhost:3000 — te llevará a la pantalla de acceso.

Node.js >= 20.12 (por `process.loadEnvFile`). Una única dependencia, `nodemailer`, usada
solo para el envío por SMTP de Gmail.

## Autenticación

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/registro` | POST | Crea la cuenta, inicia sesión y **dispara el correo de bienvenida**. |
| `/api/login` | POST | Inicia sesión. |
| `/api/logout` | POST | Cierra la sesión. |
| `/api/sesion` | GET | Devuelve el usuario de la sesión actual. |
| `/api/config` | GET | Indica al frontend si el acceso con Google está disponible. |
| `/api/auth/google` | GET | Inicia el flujo de OAuth: redirige a Google. |
| `/api/auth/google/callback` | GET | Recibe el código de Google, abre la sesión y **registra la cuenta si es nueva**. |

Los endpoints del clima (`/api/clima`, `/api/geocode`) **exigen sesión**: sin ella devuelven
401 y el frontend redirige a `/login.html`.

Decisiones de seguridad, todas con módulos nativos de Node:

- **Contraseñas con `scrypt`** y salt aleatorio por usuario. Nunca se guardan ni se
  devuelven en texto plano; el hash jamás sale en una respuesta de la API.
- **Sesiones en cookie firmada con HMAC-SHA256** (`httpOnly`, `SameSite=Lax`, 7 días).
  Si se manipula la cookie, la firma no cuadra y la sesión se rechaza.
  La clave de firma es `SESSION_SECRET`.
- **Comparaciones con `timingSafeEqual`** para no filtrar información por el tiempo de respuesta.
- **Login genérico**: "Correo o contraseña incorrectos" tanto si la cuenta existe como si no,
  para no revelar qué correos están registrados.
- **Límite de intentos**: 5 fallos bloquean ese correo 15 minutos.

Los usuarios se guardan en `data/usuarios.json`, que está en `.gitignore`.
Para producción esto se sustituiría por una base de datos real.

## Acceso con Google (OAuth 2.0)

Flujo de **código de autorización**, entero en el servidor: el navegador nunca ve el
`GOOGLE_CLIENT_SECRET`. Implementado en `google.js`, sin dependencias.

1. El usuario pulsa **Continuar con Google** → `GET /api/auth/google`.
2. El servidor genera un `state` aleatorio de 32 bytes, lo guarda en una cookie `httpOnly`
   de 10 minutos y redirige a Google.
3. Google devuelve el control a `/api/auth/google/callback`. Se comprueba que el `state`
   recibido coincida con el de la cookie (protección CSRF).
4. El código se canjea por un `id_token` en `oauth2.googleapis.com/token`, usando el
   client secret. Del token se leen `sub`, `email` y `name`, y se verifica que el `aud`
   sea esta aplicación y que no haya caducado.
5. Si el correo ya existe se entra y se asocia el `googleId`; si no, **se crea la cuenta y
   se dispara el correo de bienvenida**, igual que en el registro con contraseña.

Detalles:

- Las cuentas creadas con Google **no tienen contraseña** (`password: null`). Si alguien
  intenta entrar con contraseña en una de ellas, recibe un 409 `USAR_GOOGLE` que le indica
  usar el botón. Nunca pueden validar con contraseña vacía.
- Los errores del flujo (cancelación, `state` inválido, fallo de Google) **no devuelven JSON
  crudo**: redirigen a `/login.html?error=…` y la pantalla de acceso muestra el mensaje.
- Si faltan las credenciales, `/api/config` devuelve `{"google": false}`, el botón no se
  muestra y la app sigue funcionando con contraseña.

### Configurar las credenciales

En [Google Cloud Console](https://console.cloud.google.com/apis/credentials), dentro de tu
proyecto: **Crear credenciales → ID de cliente de OAuth → Aplicación web**, y registra como
**URI de redireccionamiento autorizado** exactamente:

```
http://localhost:3000/api/auth/google/callback
```

Copia el *Client ID* y el *Client secret* a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`
en tu `.env`. Mientras la app esté en modo de prueba, solo podrán entrar las cuentas
añadidas como usuarios de prueba en la pantalla de consentimiento.

## Correo de bienvenida

Es una **reacción automática al registro**, no un botón aparte.

**Tres proveedores**, aislados en `correo.js` y elegidos automáticamente según las variables
de ambiente. Las credenciales nunca se escriben en el código.

| Proveedor | Se activa con | Destinatarios |
|---|---|---|
| `gmail` | `GMAIL_USER` + `GMAIL_APP_PASSWORD` | **Cualquiera.** SMTP de Gmail vía nodemailer. ~500 correos/día. |
| `resend` | `RESEND_API_KEY` | Con el remitente de pruebas `onboarding@resend.dev`, **solo tu propia cuenta**; para escribir a cualquiera hay que verificar un dominio. |
| `consola` | nada configurado | Ninguno: el mensaje se imprime en el log. La app funciona igual recién clonada. |

Prioridad: Gmail → Resend → consola. Se puede forzar uno con `MAIL_PROVIDER=gmail|resend|consola`.

### Configurar Gmail

`GMAIL_APP_PASSWORD` **no** es la contraseña de la cuenta, sino una *contraseña de
aplicación* de 16 caracteres:

1. Activa la verificación en 2 pasos en https://myaccount.google.com/security
2. Genera la contraseña en https://myaccount.google.com/apppasswords
3. Ponla en `GMAIL_APP_PASSWORD` (los espacios se ignoran) y tu correo en `GMAIL_USER`.

Gmail reescribe el remitente a la cuenta autenticada, así que `MAIL_FROM` se calcula solo
a partir de `GMAIL_USER` si no lo defines.

**Se dispara en el evento correcto.** En `rutaRegistro` (`server.js`) el orden es:

1. Se valida y se crea la cuenta, y se persiste.
2. Se responde `201` al navegador con la sesión ya iniciada.
3. **Después** se lanza el correo con `setImmediate`, **sin `await`**.

**El registro no espera al proveedor.** Como el envío va fuera del ciclo de respuesta, la
latencia del correo no la sufre el usuario. Si el envío falla, se registra en el log y la
cuenta sigue creada: un problema de correo nunca rompe un registro. `correo.js` reintenta
3 veces con espera creciente ante errores temporales (429, 5xx, fallos de red), y no reintenta
ante errores de configuración (4xx de Resend, `EAUTH` de Gmail), donde insistir no sirve de nada.

## Variables de ambiente

Se definen en `.env`, que está en `.gitignore` y **nunca se sube al repositorio**.
La plantilla versionada es `.env.example`.

| Variable | Por defecto | Descripción |
|---|---|---|
| `GOOGLE_CLIENT_ID` | *(vacía)* | ID de cliente de OAuth. Sin él, el botón de Google se oculta. |
| `GOOGLE_CLIENT_SECRET` | *(vacía)* | Secreto de cliente de OAuth. Solo vive en el servidor. |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/auth/google/callback` | Debe coincidir exactamente con el registrado en Google Cloud. |
| `MAIL_PROVIDER` | *(automático)* | Fuerza el proveedor: `gmail`, `resend` o `consola`. |
| `GMAIL_USER` | *(vacía)* | Cuenta de Gmail desde la que se envía. |
| `GMAIL_APP_PASSWORD` | *(vacía)* | Contraseña de aplicación de 16 caracteres (no la de la cuenta). |
| `RESEND_API_KEY` | *(vacía)* | API key de Resend. |
| `MAIL_FROM` | *(según proveedor)* | Remitente del correo de bienvenida. |
| `APP_URL` | `http://localhost:3000` | URL usada en los enlaces del correo. |
| `MAIL_TIMEOUT_MS` | `10000` | Tiempo máximo de espera del proveedor de correo. |
| `SESSION_SECRET` | *(temporal)* | Clave para firmar las cookies de sesión. |
| `COOKIE_SECURE` | `false` | Marca las cookies como `Secure` (solo con HTTPS). |
| `OPEN_METEO_API_KEY` | *(vacía)* | API key de Open-Meteo. El plan gratuito no la requiere. |
| `PORT` | `3000` | Puerto del servidor. |
| `OPEN_METEO_TIMEOUT_MS` | `10000` | Tiempo máximo de espera hacia Open-Meteo. |
| `CACHE_TTL_MS` | `600000` | Duración de la caché de respuestas (10 min). |

Genera un `SESSION_SECRET` con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Nota**: con Resend y el remitente `onboarding@resend.dev` solo se puede enviar a la
> dirección con la que creaste la cuenta. Por eso el proveedor por defecto para enviar a
> cualquiera es Gmail.

## API del clima

| Endpoint | Parámetros | Descripción |
|---|---|---|
| `GET /api/clima` | `lat`, `lon`, `unidad` | Pronóstico actual, por hora (24 h) y de 7 días. |
| `GET /api/geocode` | `q` (mín. 2 caracteres) | Busca ubicaciones por nombre y devuelve sus coordenadas. |

Ambos validan la entrada, aplican caché y devuelven los errores con la forma:

```json
{ "error": true, "codigo": "FUERA_DE_RANGO", "mensaje": "El parámetro \"lat\" debe estar entre -90 y 90." }
```

## Manejo de errores

**En el backend**, cada fallo se traduce a un código y un mensaje en español:

| Situación | HTTP | Código |
|---|---|---|
| Datos de registro inválidos | 400 | `DATOS_INVALIDOS` |
| Correo ya registrado | 409 | `EMAIL_DUPLICADO` |
| Credenciales incorrectas | 401 | `CREDENCIALES` |
| Contraseña en una cuenta de Google | 409 | `USAR_GOOGLE` |
| Sin sesión activa | 401 | `NO_AUTENTICADO` |
| Demasiados intentos de acceso | 429 | `BLOQUEADO` |
| `lat`/`lon` no numéricos o ausentes | 400 | `PARAMETRO_INVALIDO` |
| `lat`/`lon` fuera de rango | 400 | `FUERA_DE_RANGO` |
| Open-Meteo no responde a tiempo | 504 | `TIMEOUT` |
| Sin conexión con Open-Meteo | 502 | `SIN_CONEXION` |
| Límite de peticiones alcanzado | 429 | `LIMITE` |
| API key rechazada | 502 | `API_KEY_INVALIDA` |
| Cuerpo JSON inválido o enorme | 400 / 413 | `JSON_INVALIDO` / `CUERPO_GRANDE` |
| Endpoint o método incorrectos | 404 / 405 | `NO_ENCONTRADO` / `METODO` |

**En el frontend**:

- `AbortController` con timeout de 12 s: ninguna consulta se queda colgada.
- Los errores crudos del navegador (`Failed to fetch`) nunca llegan a la interfaz.
- Botón **Reintentar** junto al mensaje de error.
- Un 401 en cualquier petición devuelve al usuario a la pantalla de acceso.
- Búsqueda sin coincidencias: aviso explícito en el desplegable.
- Contadores de petición que descartan las respuestas que llegan tarde.
- Validación de rangos en las coordenadas y gestión de los errores de geolocalización.

## Funcionalidades del clima

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
| `login.html` / `login.js` | pantalla de acceso: iniciar sesión y crear cuenta |
| `index.html` / `app.js` | app del clima (requiere sesión) |
| `styles.css` | estilos de ambas pantallas |
| `server.js` | rutas, proxy a Open-Meteo, caché y errores |
| `auth.js` | usuarios, contraseñas y sesiones |
| `google.js` | acceso con Google (OAuth 2.0) |
| `correo.js` | proveedores de correo (Gmail/Resend/consola) y plantilla de bienvenida |
| `.env.example` | plantilla de variables de ambiente |

Los `weather_code` son códigos WMO; la tabla de traducción está en la constante `WMO` de `app.js`.

---

Datos de [Open-Meteo.com](https://open-meteo.com/), licencia CC BY 4.0.
