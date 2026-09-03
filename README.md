# ⛅ AppClima

Aplicación de clima que consume la [API de Open-Meteo](https://open-meteo.com/en/docs),
con **registro e inicio de sesión** y **correo de bienvenida automático**.

El usuario puede introducir latitud y longitud, buscar una ubicación por nombre o usar
la geolocalización del navegador.

Arquitectura **frontend + backend**: el navegador nunca llama a servicios externos
directamente, así que las API keys viven únicamente en el servidor, en variables de ambiente.

```
navegador  →  backend (server.js)  →  Open-Meteo      (clima)
                    │                └─ OPEN_METEO_API_KEY
                    └──────────────→  Resend          (correo de bienvenida)
                                      └─ RESEND_API_KEY
```

## Cómo ejecutarla

```bash
cp .env.example .env    # y rellena SESSION_SECRET y RESEND_API_KEY
npm start               # o: node server.js
```

Abre http://localhost:3000 — te llevará a la pantalla de acceso.

Sin dependencias externas: solo Node.js (>= 20.12, por `process.loadEnvFile`).

## Autenticación

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/registro` | POST | Crea la cuenta, inicia sesión y **dispara el correo de bienvenida**. |
| `/api/login` | POST | Inicia sesión. |
| `/api/logout` | POST | Cierra la sesión. |
| `/api/sesion` | GET | Devuelve el usuario de la sesión actual. |

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

## Correo de bienvenida

Es una **reacción automática al registro**, no un botón aparte.

**Proveedor: [Resend](https://resend.com)** — API HTTPS, sin dependencias. La lógica está
aislada en `correo.js`, así que cambiar a SendGrid o Nodemailer solo implica tocar ese archivo.

**La API key va en `RESEND_API_KEY`**, nunca en el código. Si no está definida, se usa el
proveedor `consola`: el mensaje se imprime en el log del servidor en vez de enviarse, de modo
que la app funciona igual recién clonada.

**Se dispara en el evento correcto.** En `rutaRegistro` (`server.js`) el orden es:

1. Se valida y se crea la cuenta, y se persiste.
2. Se responde `201` al navegador con la sesión ya iniciada.
3. **Después** se lanza el correo con `setImmediate`, **sin `await`**.

**El registro no espera al proveedor.** Como el envío va fuera del ciclo de respuesta, la
latencia del correo no la sufre el usuario. Si el envío falla, se registra en el log y la
cuenta sigue creada: un problema de correo nunca rompe un registro. `correo.js` reintenta
3 veces con espera creciente ante errores temporales (429 y 5xx), y no reintenta ante errores
de configuración (4xx), donde insistir no sirve de nada.

## Variables de ambiente

Se definen en `.env`, que está en `.gitignore` y **nunca se sube al repositorio**.
La plantilla versionada es `.env.example`.

| Variable | Por defecto | Descripción |
|---|---|---|
| `RESEND_API_KEY` | *(vacía)* | API key de Resend. Sin ella los correos se imprimen en el log. |
| `MAIL_FROM` | `AppClima <onboarding@resend.dev>` | Remitente del correo de bienvenida. |
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

> **Nota sobre el remitente**: `onboarding@resend.dev` funciona sin verificar dominio, pero
> Resend solo permite enviarlo a la dirección con la que creaste la cuenta. Para escribir a
> cualquier destinatario hay que verificar un dominio propio y ajustar `MAIL_FROM`.

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
| `correo.js` | proveedor de correo y plantilla de bienvenida |
| `.env.example` | plantilla de variables de ambiente |

Los `weather_code` son códigos WMO; la tabla de traducción está en la constante `WMO` de `app.js`.

---

Datos de [Open-Meteo.com](https://open-meteo.com/), licencia CC BY 4.0.
