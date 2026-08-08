# L4D2 Panel — Diseño técnico: AUTENTICACIÓN (Steam OpenID, sin Cognito)

> Dominio: **auth**. Fuente de verdad de producto: `../especificaciones-v1.md` (ADR **D4** = login
> solo con Steam; sin Cognito, sin email/password). Este documento es suficiente para implementar
> el subsistema de autenticación sin re-diseñar. Todo el back es **Lambda Function URL detrás de
> CloudFront** (mismo origen `l4d2.ventrax.dev`), datos en **DynamoDB single-table**, secretos en
> **SSM Parameter Store**. Región de cómputo: **us-east-2** (cuenta `211125402452`).

---

## 0. TL;DR (qué se construye)

1. Dos endpoints de login (`/auth/steam/login`, `/auth/steam/return`) en una Lambda `l4d2-auth`
   que implementan **Steam OpenID 2.0 en modo "dumb"/stateless** (verificación por
   `check_authentication` contra Steam, sin association store).
2. Anti-CSRF con **cookie de estado** de un solo uso (`l4d2_oauth_state`), doble-submit + firma
   OpenID del `return_to`.
3. Perfil (nick + avatar) por **Steam Web API `GetPlayerSummaries`**; key en SSM; **fallback**
   cosmético si no hay key.
4. Sesión propia = **JWT HS256** firmado por el backend, secreto en SSM, guardado en **cookie
   httpOnly** `l4d2_session`.
5. **Helper compartido** `verifyJwt()` que cada Lambda usa en proceso (secreto cacheado en memoria,
   0 llamadas de red por request).
6. **Flag `operador`** como atributo booleano en DynamoDB (source of truth), seteado a mano.
7. Modelo de amenazas + endurecimiento (robo/replay, spoof de SteamID, abuso del WoL).
8. **Same-origin** detrás de CloudFront → sin CORS permisivo; blindaje con header secreto
   CloudFront→origen + validación de `Origin`.

---

## 1. Supuestos y dependencias sobre otros dominios

Declarados explícitamente porque este dominio depende de ellos pero **no los define**:

| # | Supuesto / dependencia | Dominio dueño | Qué asumo aquí |
|---|---|---|---|
| A1 | Tabla DynamoDB single-table llamada **`l4d2-panel`** (PK/SK). | modelo-de-datos | Ítem `Usuario`: `PK=USER#<steamid64>`, `SK=PROFILE`. Atributos que este dominio lee/escribe: `steamId64`, `nick`, `avatar`, `operador` (bool), `suspendido` (bool), `createdAt`, `lastLoginAt`. |
| A2 | Distribución CloudFront única sirviendo `l4d2.ventrax.dev` con comportamientos por path (`/*`→S3, `/api/*`→Lambda api, `/auth/*`→Lambda auth). | infra/CDK | Yo defino los **requisitos** de cache/origin policy y headers (§10), la infra los implementa. |
| A3 | Cert ACM en **us-east-1** para el dominio; zona Route 53 `Z0798505KCA3V0GU54OJ`. | infra/CDK | Solo lo referencio. |
| A4 | Lógica de reserva, cola, WoL y contadores de rate-limit (encendidos/día, cooldown, switch global). | reserva / WoL | Auth solo **garantiza identidad + enforcement de `suspendido`** y expone `sub`=SteamID64. Los contadores viven en esos dominios; aquí digo qué controles de auth los alimentan (§13.3). |
| A5 | El agente local siembra admin in-game por-servidor usando el **SteamID64** del reservador. | agente-local | Auth entrega ese SteamID64 verificado; el matching in-game se apoya en él. |

Si algo de esto cambia (p.ej. el nombre de la tabla o el layout de claves), **solo se ajustan
constantes**, no el diseño.

---

## 2. Recursos AWS de este dominio

| Recurso | Tipo | Región | Notas |
|---|---|---|---|
| `l4d2-auth` | Lambda (Function URL, AuthType `NONE`) | us-east-2 | Rutea `/auth/steam/login`, `/auth/steam/return`, `/auth/logout`. Node.js 20, arm64. |
| `l4d2-api` | Lambda (Function URL, AuthType `NONE`) | us-east-2 | API de negocio; incluye `GET /api/me`. Usa el mismo helper de JWT. |
| `l4d2-panel` | DynamoDB single-table | us-east-2 | Ítem `Usuario` (ver A1). Provisioned 25/25 (free tier). |
| SSM params `/l4d2-panel/...` | Parameter Store | us-east-2 | Ver §3. |
| CloudFront + ACM | CDN + cert | global / us-east-1 | Same-origin; header secreto origen (§10). |

**Function URL con AuthType `NONE`**: la URL `https://<id>.lambda-url.us-east-2.on.aws` es pública.
La autenticación real es **nuestro JWT**; el acceso directo saltándose CloudFront se bloquea con el
header secreto CloudFront→origen (§10.3). No se usa IAM auth en la Function URL porque el navegador
no firma SigV4.

---

## 3. Parámetros SSM (SecureString salvo indicado)

| Nombre | Tipo | Contenido | Quién lo lee |
|---|---|---|---|
| `/l4d2-panel/auth/jwt-secret` | SecureString | Clave HMAC HS256, ≥32 bytes aleatorios (base64). | `l4d2-auth` (firma+verifica), `l4d2-api` (verifica) |
| `/l4d2-panel/auth/jwt-secret-previous` | SecureString (opcional) | Clave anterior durante una rotación. | ambas Lambdas (solo verifican) |
| `/l4d2-panel/steam/web-api-key` | SecureString | Steam Web API key (32 hex). | `l4d2-auth` |
| `/l4d2-panel/auth/cf-origin-secret` | SecureString | Valor del header `X-Origin-Verify` que CloudFront inyecta y las Lambdas exigen. | CloudFront (config) + ambas Lambdas |

Generación de la key JWT (una vez): `openssl rand -base64 48`.

**IAM (mínimo privilegio) para cada rol de ejecución Lambda:**

```
Effect: Allow
Action: ssm:GetParameter, ssm:GetParameters
Resource:
  - arn:aws:ssm:us-east-2:211125402452:parameter/l4d2-panel/auth/jwt-secret
  - arn:aws:ssm:us-east-2:211125402452:parameter/l4d2-panel/auth/jwt-secret-previous
  - arn:aws:ssm:us-east-2:211125402452:parameter/l4d2-panel/auth/cf-origin-secret
  # l4d2-auth añade además:
  - arn:aws:ssm:us-east-2:211125402452:parameter/l4d2-panel/steam/web-api-key
```

Con la **clave administrada por AWS `alias/aws/ssm`** (default para SecureString) no hace falta
policy KMS extra: `GetParameter` con `WithDecryption=true` funciona porque la key policy del CMK
gestionado autoriza a los principales de la cuenta. No crear CMK propio (sobra para hobby).

---

## 4. Flujo Steam OpenID 2.0 — visión

Steam **no** implementa OIDC/OAuth2; implementa **OpenID 2.0**. No devuelve perfil (nick/avatar);
solo devuelve la **identidad verificada** = una URL que contiene el **SteamID64**. El perfil se
obtiene aparte por la Web API (§6). Usamos el modo **stateless ("dumb")**: no pre-negociamos
asociación; verificamos cada respuesta reenviándola a Steam con `openid.mode=check_authentication`.
Es lo más simple y sin estado — ideal para hobby.

```
 Navegador                 l4d2-auth (Lambda)              steamcommunity.com/openid
    │                            │                                   │
    │  GET /auth/steam/login     │                                   │
    ├───────────────────────────►│                                   │
    │                            │  genera nonce `state`             │
    │                            │  Set-Cookie l4d2_oauth_state=state│
    │  302 → Steam (con params)  │  (HttpOnly, Secure, SameSite=Lax) │
    │◄───────────────────────────┤                                   │
    │  GET /openid/login?openid.mode=checkid_setup&...&return_to=...&state=nonce
    ├────────────────────────────────────────────────────────────────►│
    │                       (el usuario inicia sesión en Steam)       │
    │  302 → /auth/steam/return?openid.mode=id_res&openid.claimed_id=.../id/7656…&openid.sig=…&state=nonce
    │◄────────────────────────────────────────────────────────────────┤
    │  GET /auth/steam/return?...│                                   │
    ├───────────────────────────►│  1) cookie.state == query.state?  │
    │                            │  2) POST check_authentication ───►│
    │                            │◄──── is_valid:true ───────────────┤
    │                            │  3) extrae SteamID64 de claimed_id│
    │                            │  4) GetPlayerSummaries (nick/avatar)
    │                            │  5) upsert Usuario en DynamoDB    │
    │                            │  6) firma JWT propio              │
    │  302 → /  (SPA)            │  Set-Cookie l4d2_session=JWT      │
    │  + borra l4d2_oauth_state  │  (HttpOnly, Secure, SameSite=Lax) │
    │◄───────────────────────────┤                                   │
```

### 4.1 Constantes

```
STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login"
REALM                 = "https://l4d2.ventrax.dev"
RETURN_TO             = "https://l4d2.ventrax.dev/auth/steam/return"
CLAIMED_ID_REGEX      = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119[0-9]{10})$/
```

`realm` debe ser prefijo de `return_to` (lo es). El SteamID64 de L4D2 empieza por `7656119`
(base `76561197960265728`), 17 dígitos.

---

## 5. Endpoint `GET /auth/steam/login`

Arma la redirección a Steam en **modo `checkid_setup`** con `identifier_select` (Steam elige la
identidad de la sesión logueada del usuario).

**Parámetros de la query a Steam** (exactos):

| Param | Valor |
|---|---|
| `openid.ns` | `http://specs.openid.net/auth/2.0` |
| `openid.mode` | `checkid_setup` |
| `openid.return_to` | `https://l4d2.ventrax.dev/auth/steam/return?state=<nonce>` |
| `openid.realm` | `https://l4d2.ventrax.dev` |
| `openid.identity` | `http://specs.openid.net/auth/2.0/identifier_select` |
| `openid.claimed_id` | `http://specs.openid.net/auth/2.0/identifier_select` |

El **`state` se mete en `return_to`** (no como param OpenID suelto) para que Steam lo **firme**
(queda dentro de `openid.signed`), y también se setea como **cookie de un solo uso**.

```js
// l4d2-auth :: handler para GET /auth/steam/login
function handleLogin(event) {
  const nonce = base64url(crypto.randomBytes(24));           // ~192 bits
  const returnTo = `${RETURN_TO}?state=${encodeURIComponent(nonce)}`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": REALM,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return {
    statusCode: 302,
    headers: { Location: `${STEAM_OPENID_ENDPOINT}?${params}` },
    cookies: [
      // Lax es OBLIGATORIO: el retorno de Steam es una navegación top-level cross-site (GET);
      // una cookie SameSite=Strict NO se enviaría y el check fallaría.
      `l4d2_oauth_state=${nonce}; Max-Age=600; Path=/auth/steam; HttpOnly; Secure; SameSite=Lax`,
    ],
  };
}
```

Notas:
- `Path=/auth/steam` acota la cookie de estado al flujo (no viaja al resto del sitio).
- `Max-Age=600` (10 min): ventana de login. Si expira, el usuario reintenta (un clic).
- Se usa `cookies: [...]` (formato de respuesta de Lambda Function URL v2, que soporta multi-cookie).

---

## 6. Endpoint `GET /auth/steam/return` (validación)

Aquí ocurre TODA la seguridad de la identidad. Pasos, en orden, **todos obligatorios**:

1. **Anti-CSRF (state):** leer `l4d2_oauth_state` de la cookie y `state` de la query; deben existir
   y ser **iguales** (comparación de tiempo constante). Si falta o difiere → `400`. La cookie se
   **borra** siempre al final (un solo uso).
2. **Sanity de params OpenID:** `openid.mode == "id_res"`; `openid.return_to` empieza por nuestro
   `RETURN_TO`; `openid.claimed_id` casa con `CLAIMED_ID_REGEX`.
3. **Verificación de firma contra Steam (`check_authentication`):** re-POST de **todos** los
   `openid.*` recibidos con `openid.mode` cambiado a `check_authentication`, form-url-encoded, a
   `STEAM_OPENID_ENDPOINT`. Steam responde texto plano; exigir la línea `is_valid:true`.
   **Sin este paso cualquiera podría inventar params** — es el corazón del anti-spoof (§13.2).
4. **Extraer SteamID64** del grupo capturado de `claimed_id`.
5. **Perfil** (nick/avatar) por Web API (§7); no bloqueante.
6. **Upsert Usuario** en DynamoDB (§8).
7. **Firmar JWT** propio (§9) y setear cookie `l4d2_session`.
8. **302 → `/`** (SPA). Borra `l4d2_oauth_state`.

```js
// l4d2-auth :: handler para GET /auth/steam/return
async function handleReturn(event) {
  const q = event.queryStringParameters || {};
  const cookieState = readCookie(event, "l4d2_oauth_state");

  // (1) anti-CSRF
  if (!cookieState || !q.state || !timingSafeEqual(cookieState, q.state))
    return deny(400, "estado inválido");

  // (2) sanity
  if (q["openid.mode"] !== "id_res") return deny(400, "modo inesperado");
  if (!q["openid.return_to"]?.startsWith(RETURN_TO)) return deny(400, "return_to inválido");
  const m = CLAIMED_ID_REGEX.exec(q["openid.claimed_id"] || "");
  if (!m) return deny(400, "claimed_id inválido");
  const steamId64 = m[1];

  // (3) verificación contra Steam (modo dumb)
  const verifyBody = new URLSearchParams({ ...pickOpenidParams(q), "openid.mode": "check_authentication" });
  const resp = await fetch(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: verifyBody.toString(),
  });
  const text = await resp.text();
  if (!/(^|\n)is_valid:true(\r?\n|$)/.test(text)) return deny(401, "Steam rechazó la aserción");

  // (4)+(5) perfil (best-effort)
  const profile = await fetchPlayerSummary(steamId64);   // {nick, avatar} o fallback

  // (6) upsert
  await upsertUsuario(steamId64, profile);               // no toca operador/suspendido si ya existe

  // (7) sesión
  const now = Math.floor(Date.now() / 1000);
  const user = await getUsuario(steamId64);              // para leer flag operador -> claim op
  const jwt = signJwt({
    sub: steamId64, nick: profile.nick, op: !!user.operador,
    iss: "l4d2.ventrax.dev", aud: "l4d2-panel", iat: now, exp: now + SESSION_TTL,
  });

  // (8) redirect + cookies
  return {
    statusCode: 302,
    headers: { Location: "https://l4d2.ventrax.dev/" },
    cookies: [
      `l4d2_session=${jwt}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `l4d2_oauth_state=; Max-Age=0; Path=/auth/steam; HttpOnly; Secure; SameSite=Lax`, // borra
    ],
  };
}

function pickOpenidParams(q) {          // solo los openid.* que Steam envió
  return Object.fromEntries(Object.entries(q).filter(([k]) => k.startsWith("openid.")));
}
```

### 6.1 Anti-CSRF y anti-replay — por qué basta

- **Login CSRF** (forzar al víctima a loguearse en la cuenta del atacante): el `return_to` del
  atacante lleva **su** `state`; el navegador de la víctima no tiene esa cookie (o tiene otra) →
  mismatch → `400`. Cubierto por el doble-submit.
- **Integridad del state:** al ir dentro de `return_to`, Steam lo firma; `check_authentication`
  detectaría manipulación. Doble candado.
- **Replay de la aserción:** la cookie de estado es de **un solo uso** (se borra en el retorno);
  reproducir la misma URL en el navegador de la víctima falla por falta de cookie. Reproducirla en
  el del atacante solo lo loguea en su propia cuenta. Además `openid.response_nonce` trae timestamp;
  rechazamos si tiene > 5 min. **No** mantenemos un store de nonces usados (sobra para hobby; el
  single-use del state ya cierra el vector).

---

## 7. Perfil: nick + avatar (Steam Web API)

Steam OpenID no da perfil. Se obtiene con **`ISteamUser/GetPlayerSummaries`**:

```
GET https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/
    ?key=<STEAM_WEB_API_KEY>&steamids=<steamid64>
```

Respuesta relevante: `response.players[0]`:

| Campo Steam | Uso |
|---|---|
| `personaname` | `nick` (nombre visible en el panel) |
| `avatarfull` | `avatar` (URL 184×184, dominio `*.steamstatic.com`) |
| `profileurl` | opcional (link al perfil) |

```js
async function fetchPlayerSummary(steamId64) {
  const key = await getSSM("/l4d2-panel/steam/web-api-key"); // cacheado (§9.4)
  if (!key) return fallbackProfile(steamId64);               // FALLBACK: no hay key
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`
              + `?key=${key}&steamids=${steamId64}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const p = (await r.json())?.response?.players?.[0];
    if (!p) return fallbackProfile(steamId64);
    return { nick: p.personaname, avatar: p.avatarfull };
  } catch {
    return fallbackProfile(steamId64);                       // FALLBACK: API caída/timeout
  }
}
function fallbackProfile(steamId64) {
  return { nick: `Jugador ${steamId64.slice(-4)}`, avatar: null };
}
```

**Dónde vive la key:** SSM `/l4d2-panel/steam/web-api-key` (SecureString). Se obtiene en
<https://steamcommunity.com/dev/apikey> (requiere una cuenta Steam del operador; el "domain" pedido
es informativo, cualquiera sirve). Es **de la cuenta del operador**, no del jugador.

**Fallback (sin key o API caída):** el login **NO se bloquea**. Se guarda `nick="Jugador <4
últimos>"`, `avatar=null`; la SPA muestra un avatar placeholder. El perfil es **cosmético**; la
identidad (SteamID64) ya está verificada por OpenID. Se re-intenta refrescar el perfil en el
próximo login. Rationale hobby: nunca dejar caer un login por un dato decorativo.

**Refresco:** en cada login se hace upsert del nick/avatar (barato, sirve para mantenerlo fresco).
No hay job periódico (sobra).

---

## 8. Upsert del Usuario en DynamoDB

Ítem (ver A1). El upsert **no debe pisar** `operador`/`suspendido` si el ítem ya existe:

```
UpdateItem  Key { PK: "USER#<steamid64>", SK: "PROFILE" }
UpdateExpression:
  SET steamId64 = :sid,
      nick      = :nick,
      avatar    = :avatar,
      lastLoginAt = :now,
      createdAt = if_not_exists(createdAt, :now),
      operador  = if_not_exists(operador, :false),
      suspendido= if_not_exists(suspendido, :false),
      entityType= if_not_exists(entityType, :usuario)
```

Así, la primera vez crea el usuario con flags en `false`; en logins siguientes solo refresca
nick/avatar/lastLoginAt y **respeta** los flags puestos a mano (§11).

---

## 9. Sesión propia: JWT

### 9.1 Algoritmo y clave

- **HS256** (HMAC-SHA256), secreto simétrico en SSM (§3). Justificación hobby: **el mismo backend
  firma y verifica**; no hay terceros que necesiten verificar → asimétrico (RS256/EdDSA) sería
  complejidad inútil. Un secreto de ≥32 bytes es suficiente.
- **Nunca** aceptar `alg` del token: el verificador **exige** `HS256` y rechaza cualquier otro
  (incluido `none`). Es la trampa clásica de JWT.

### 9.2 Claims

| Claim | Tipo | Ejemplo | Propósito |
|---|---|---|---|
| `sub` | string | `"76561198012345678"` | **SteamID64 verificado** = identidad. |
| `iss` | string | `"l4d2.ventrax.dev"` | Emisor; se valida. |
| `aud` | string | `"l4d2-panel"` | Audiencia; se valida. |
| `iat` | number | `1770000000` | Emitido en (epoch s). Base de la renovación deslizante. |
| `exp` | number | `1770604800` | Expira (epoch s). |
| `nick` | string | `"Ventrax"` | Cosmético: pinta la UI sin leer DB. Puede quedar viejo; no es de confianza para lógica. |
| `op` | bool | `false` | **Conveniencia** para UI (mostrar zona operador). **NO** es autorización: toda acción privilegiada re-lee DynamoDB (§9.6, §11). |

No metemos `suspendido` en el token (se chequea en DB en endpoints de escritura, §10). No usamos
`jti`/denylist (sobra).

### 9.3 Expiración y renovación

- **`SESSION_TTL = 7 días`** (604800 s). Justificación: el peor abuso de una sesión robada es
  **reservar** (encender la PC) — acotado por rate-limits y reversible (suspender); el reservador
  **no puede banear**. Un TTL corto molestaría al usuario sin ganancia real de seguridad. Re-login
  = un clic en Steam.
- **Renovación deslizante (sin refresh token):** en cualquier request autenticado, si el token es
  válido pero `now - iat > 1 día`, la Lambda re-emite uno nuevo (mismo `sub`, nuevo `iat/exp`) y lo
  setea vía `Set-Cookie`. Así una sesión activa no expira nunca; una inactiva 7 días caduca. **No
  hay refresh token** (montar ese baile sería sobre-ingeniería dado que Steam re-login es trivial).
- **Logout** (`POST /auth/logout`): `Set-Cookie l4d2_session=; Max-Age=0`. Como el JWT es stateless,
  el token viejo seguiría siendo criptográficamente válido hasta `exp` si el atacante ya lo tenía;
  el logout limpia el navegador honesto. Para **revocación real** ver §13.1.

### 9.4 Almacenamiento en el cliente — decisión y trade-off

**Decisión: cookie `l4d2_session` con `HttpOnly; Secure; SameSite=Lax; Path=/`.**

| | Cookie `HttpOnly` (elegida) | `localStorage` + header `Authorization` |
|---|---|---|
| Robo por **XSS** | **Inmune**: JS no puede leer la cookie. | Vulnerable: cualquier XSS lee el token. |
| **CSRF** | Posible en teoría → mitigado por `SameSite=Lax` + chequeo de `Origin` (§12) + header secreto CF (§10.3). | Inmune (no se auto-envía). |
| Envío al API | Automático (same-origin, CloudFront). | Manual: el SPA añade `Authorization: Bearer`. |
| Complejidad SPA | Cero (el navegador la maneja). | El SPA guarda/adjunta el token. |

Como **todo es same-origin** detrás de CloudFront, la cookie se auto-envía sin CORS y el token
**nunca toca JavaScript** → se elimina el peor vector (robo por XSS). El único costo (CSRF) se cubre
barato. Es la opción correcta para este proyecto. (Si en el futuro se quisiera un cliente no-web,
se añadiría además soporte de `Authorization: Bearer` reusando el mismo `verifyJwt`.)

Atributos de la cookie de sesión:
```
l4d2_session=<jwt>; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
```
Host-only (sin `Domain=`) para que no la hereden subdominios ajenos. `SameSite=Lax` (no `Strict`)
para que sobreviva la navegación top-level desde el `302` post-login; para el API, las llamadas del
SPA son same-origin `fetch` y la cookie viaja igual.

### 9.5 Firmar / verificar (pseudocódigo, sin dependencias)

Node 20 trae `crypto` y `fetch` globales; JWT HS256 se hace a mano (~30 líneas) — **cero deps** que
mantener. (Alternativa: `jose`, pero para hobby preferimos sin dependencias.)

```js
const crypto = require("crypto");
const b64url  = (buf) => Buffer.from(buf).toString("base64url");
const b64json = (obj) => b64url(JSON.stringify(obj));

function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const data = `${b64json(header)}.${b64json(payload)}`;
  const sig  = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyJwt(token, secrets /* [current, previous?] */) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("formato");
  const [h, p, sig] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url"));
  if (header.alg !== "HS256") throw new Error("alg");          // rechaza none/otros
  const data = `${h}.${p}`;
  const ok = secrets.some((s) => {                             // acepta actual o anterior (rotación)
    const expected = crypto.createHmac("sha256", s).update(data).digest("base64url");
    return expected.length === sig.length &&
           crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  });
  if (!ok) throw new Error("firma");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now >= claims.exp) throw new Error("expirado");
  if (claims.iat && now < claims.iat - 60) throw new Error("iat futuro");
  if (claims.iss !== "l4d2.ventrax.dev") throw new Error("iss");
  if (claims.aud !== "l4d2-panel") throw new Error("aud");
  return claims;                                               // {sub, nick, op, iat, exp, ...}
}
```

### 9.6 Rotación del secreto

Firmar siempre con `/l4d2-panel/auth/jwt-secret`; verificar contra `[current, previous]`. Para
rotar: copiar el actual a `.../jwt-secret-previous`, poner uno nuevo en `.../jwt-secret`. Las
sesiones vivas siguen validando por `previous` durante su TTL; las nuevas usan `current`. Tras 7
días, vaciar `previous`. Rotar el secreto **sin** poblar `previous` = **logout global inmediato**
(útil como botón de pánico, §13.1).

---

## 10. Validación del JWT en cada Lambda

### 10.1 Helper compartido

Un módulo `auth.js` (bundleado en ambas Lambdas o como **Lambda Layer** `l4d2-auth-common`) expone
`getSession(event)`:

```js
let SECRETS = null;                       // caché a nivel módulo (persiste entre invocaciones)
async function loadSecrets() {
  if (SECRETS) return SECRETS;
  const cur  = await getSSM("/l4d2-panel/auth/jwt-secret", true);
  const prev = await getSSM("/l4d2-panel/auth/jwt-secret-previous", true).catch(() => null);
  SECRETS = prev ? [cur, prev] : [cur];
  return SECRETS;
}

async function getSession(event) {        // -> claims o null
  const token = readCookie(event, "l4d2_session");
  if (!token) return null;
  try { return verifyJwt(token, await loadSecrets()); }
  catch { return null; }
}
```

- **SSM se lee una vez por cold start** y queda en memoria del contenedor → **0 llamadas de red por
  request**, verificación puramente en CPU (HMAC). Barato y rápido.
- La caché sobrevive mientras el contenedor esté vivo (minutos–horas). Tras una rotación, los
  contenedores nuevos toman el secreto nuevo; los viejos siguen firmando con el anterior hasta
  reciclarse — aceptable (o forzar redeploy para invalidar la caché ya).

### 10.2 Uso por tipo de endpoint

| Tipo de endpoint | Qué chequea |
|---|---|
| **Público** (`GET /api/servers` lista, `GET /auth/steam/*`) | Nada (o `getSession` opcional para personalizar). |
| **Autenticado de lectura** (`GET /api/me`) | `getSession` != null. **Sin** GetItem. |
| **Autenticado de escritura** (`POST /api/reservar`, cerrar servidor, cola) | `getSession` + **GetItem Usuario** → rechazar si `suspendido`. Aquí también aplica renovación deslizante (§9.3). |
| **Operador** (`/sourcebans` wake, `set N`, switch global, suspender) | `getSession` + **GetItem Usuario** → exigir `operador === true` (**no** confiar en el claim `op`). |

Patrón:
```js
const s = await getSession(event);
if (!s) return json(401, { error: "no autenticado" });
// escritura:
const u = await getUsuario(s.sub);
if (u.suspendido) return json(403, { error: "cuenta suspendida" });
// operador:
if (!u.operador) return json(403, { error: "solo operador" });
```

`json()` incluye siempre los headers de seguridad (§12) y, si toca, el `Set-Cookie` de renovación.

### 10.3 Blindaje del acceso directo a la Function URL

Como AuthType es `NONE`, la Function URL es alcanzable sin pasar por CloudFront. Para forzar el paso
por CloudFront: **CloudFront inyecta `X-Origin-Verify: <secreto>`** (custom origin header) y ambas
Lambdas **rechazan (403)** cualquier request sin ese header/valor:

```js
if (header(event, "x-origin-verify") !== ORIGIN_SECRET) return json(403, {});
```
`ORIGIN_SECRET` = SSM `/l4d2-panel/auth/cf-origin-secret`, cacheado igual que el JWT. Rotable
cambiando el valor en SSM y en la config de CloudFront. Esto además hace innecesaria cualquier
config CORS en la Function URL (se deja sin CORS).

---

## 11. Flag operador

- Atributo **`operador` (bool)** en el ítem `Usuario` de DynamoDB. **Source of truth única.**
- Se setea a mano (una vez, para Ventrax):
  ```bash
  aws dynamodb update-item --profile ventrax_infra_prod --region us-east-2 \
    --table-name l4d2-panel \
    --key '{"PK":{"S":"USER#7656119XXXXXXXXXX"},"SK":{"S":"PROFILE"}}' \
    --update-expression 'SET operador = :t' \
    --expression-attribute-values '{":t":{"BOOL":true}}'
  ```
  (El SteamID64 de Ventrax se ve tras su primer login, o en su perfil Steam.)
- **Uso:** wake de `/sourcebans` (D13), y futuros: `set N`, switch global de reservas, suspender
  usuarios. Todos re-leen DynamoDB (§10.2). El claim `op` del JWT es **solo UI**.
- **`suspendido` (bool)** es el mismo mecanismo para moderación (D-§15): un usuario suspendido pasa
  el login (tiene identidad) pero los endpoints de escritura lo rechazan con `403`.

---

## 12. CORS y headers (same-origin detrás de CloudFront)

**Todo bajo `https://l4d2.ventrax.dev`** (SPA, `/api/*`, `/auth/*` en la misma distribución) →
las llamadas SPA→API son **same-origin**: **no hay preflight CORS ni se necesita `Access-Control-*`
permisivo**. Se **omite** cualquier CORS en las Function URLs (y el acceso directo se bloquea, §10.3).

### 12.1 Requisitos de comportamiento CloudFront (para infra/CDK)

Para `/api/*` y `/auth/*` (origen = Function URL):
- **CachePolicy = `CachingDisabled`** (respuestas autenticadas, nunca cachear).
- **OriginRequestPolicy** que **reenvíe**: header `Cookie`, header `Origin`, **todos** los query
  strings (OpenID manda muchos `openid.*`), y `X-Requested-With` si se usa. **No** reenviar `Host`
  (Function URL exige su propio Host).
- CloudFront debe **propagar `Set-Cookie`** de vuelta (ocurre con caching desactivado).
- CloudFront añade el custom origin header **`X-Origin-Verify`** (§10.3).

Para `/*` (origen = S3, la SPA): cacheable normal.

### 12.2 Defensa CSRF a nivel API

Con cookie de sesión auto-enviada, además de `SameSite=Lax` se **valida el `Origin`** en endpoints
de escritura:
```js
if (isWrite && header(event, "origin") !== "https://l4d2.ventrax.dev")
  return json(403, { error: "origen no permitido" });
```
Barato y efectivo: `SameSite=Lax` ya bloquea POST cross-site; el chequeo de `Origin` es cinturón +
tirantes. No hace falta token CSRF sincronizado.

### 12.3 Response headers de seguridad (Response Headers Policy de CloudFront, o en cada respuesta Lambda)

| Header | Valor |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | `default-src 'self'; img-src 'self' https://*.steamstatic.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'` |

**Nota:** esta CSP aplica a la **SPA**. La ruta **`/sourcebans/*`** (panel PHP servido desde la PC,
D13) es una app aparte con sus propias necesidades de CSP/scripts; **no** se le aplica esta CSP —
tiene su propio comportamiento en CloudFront. `img-src` permite `*.steamstatic.com` para los avatars
de Steam.

---

## 13. Modelo de amenazas

### 13.1 Robo / replay de sesión

| Vector | Defensa |
|---|---|
| **XSS roba el token** | Cookie `HttpOnly` → JS no la lee. CSP restrictiva reduce XSS. |
| **Sniffing de red** | `Secure` + HSTS + TLS (ACM). El token nunca viaja en claro. |
| **CSRF** (usar la cookie de la víctima) | `SameSite=Lax` + validación de `Origin` (§12.2) + header secreto CF (§10.3). |
| **Replay del bearer robado** | Inherente a JWT bearer, acotado por: `exp` (7 d, renovación deslizante), y sobre todo **blast radius bajo** (reservar es rate-limited y reversible; el reservador **no banea**). |
| **Replay de la aserción OpenID** | `state` de un solo uso + `return_to` firmado por Steam + `response_nonce` con ventana de 5 min. |
| **Revocación / logout global** | No hay session store; para nuke inmediato de TODAS las sesiones → **rotar `jwt-secret` sin poblar `previous`** (§9.6). Logout normal limpia la cookie del navegador honesto. |
| **Revocación de UN usuario** (ej. al suspender) | El flag `suspendido` en DB bloquea sus endpoints de escritura al instante (se chequea en cada escritura). Es la revocación efectiva que importa (un token robado suspendido no puede reservar). |

Sobre el **operador**: su token da acceso a `/sourcebans` wake y (futuro) config. Es un único
usuario. Aceptamos el mismo TTL; si se quisiera endurecer, un TTL más corto solo para `op` o un
step-up serían opciones — **se declara como opcional, no v1** (sobre-ingeniería para un operador que
es el propio dueño de la PC).

### 13.2 Suplantación de SteamID — por qué el login lo impide

El `sub` del JWT **solo** se setea desde el SteamID64 extraído de `openid.claimed_id`, y ese
`claimed_id` se acepta **únicamente** si:
1. `check_authentication` contra `steamcommunity.com` devolvió `is_valid:true` (Steam **firma** la
   aserción; el atacante no puede producir esa firma para un SteamID que no controla), y
2. `claimed_id` casa exactamente con `https://steamcommunity.com/openid/id/<17 dígitos>`.

No hay contraseña que phishear ni endpoint donde "declarar" un SteamID: la identidad la certifica
Steam. **End-to-end**: el jugador que se conecta al servidor L4D2 lo hace con su cliente Steam real
(ticket VAC/Steam liga el cliente a su SteamID), y el agente siembra admin in-game **por ese mismo
SteamID64** (A5) → la identidad es consistente desde el login web hasta el admin in-game. Nadie
puede reservar/ser admin como otro.

**Condiciones para que la garantía se sostenga** (checklist de implementación, todas obligatorias):
verificar firma vía `check_authentication` (no confiar en params), regex estricta de `claimed_id`,
validar `return_to`/`realm`, chequear `state`, y ventana de `response_nonce`.

### 13.3 Abuso: "reservar enciende físicamente la PC"

Riesgo real: spam de reservas para despertar / ciclar la PC (desgaste, luz, ruido).

| Control (capa auth) | Efecto |
|---|---|
| **Login obligatorio** para reservar (visitante solo ve, D-§2). | Elimina el abuso anónimo; ata cada reserva a un SteamID. |
| **`suspendido`** chequeado en `/api/reservar`. | Corta a un abusador identificado al instante. |
| Auth expone `sub` estable → los dominios de reserva/WoL aplican **1-por-usuario (D7)**, **tope N (D6)**, **encendidos/día**, **cooldown**, **switch global** (D-§15). | Auth es el ancla de identidad de esos contadores (A4). |

Controles que **no** son de auth pero se listan por completitud (dominio reserva/WoL): WoL
idempotente (un wake en vuelo), la PC solo despierta si hay slot libre **y** está apagada, y el
delay de 15 min de servidor vacío amortigua el flapping. **Registro abierto** (D5) permite
multicuenta de Steam, pero crear cuentas Steam tiene fricción; el tope de encendidos/día + cooldown
global acotan el daño. Detección de multicuentas está **fuera de alcance** (D16) — no se
sobre-ingeniera.

---

## 14. Endpoints (resumen)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/auth/steam/login` | — | Setea `l4d2_oauth_state`, `302` a Steam. |
| GET | `/auth/steam/return` | — | Valida OpenID, upsert, setea `l4d2_session`, `302` a `/`. |
| POST | `/auth/logout` | cookie | Borra `l4d2_session` (`Max-Age=0`). |
| GET | `/api/me` | JWT | Devuelve `{ steamId64, nick, avatar, operador, suspendido }` (lee DB para flags frescos). |

`GET /api/me` es el bootstrap del SPA: al cargar, llama `/api/me`; `200` → sesión viva (pinta
usuario), `401` → muestra botón "Iniciar sesión con Steam" (link a `/auth/steam/login`).

---

## 15. Qué NO hacer (evitar sobre-ingeniería)

- **Sin Cognito** (D4), sin API Gateway, sin refresh tokens, sin session store en DynamoDB, sin
  denylist de `jti`, sin store de nonces OpenID usados, sin CMK KMS propio, sin JWT asimétrico.
- **Sin CORS permisivo** (todo same-origin).
- **Sin librería JWT** (crypto nativo basta) — a menos que se prefiera `jose` por gusto.
- **Sin job de refresco de perfiles** (se refresca en cada login).
- El perfil (nick/avatar) es cosmético: **nunca** bloquear login por él.

---

## 16. Checklist de implementación

- [ ] Crear SSM params (§3) + policies IAM mínimas por Lambda.
- [ ] `l4d2-auth`: `GET /login`, `GET /return`, `POST /logout` (Node 20, arm64, Function URL sin CORS).
- [ ] Helper `auth.js` (`signJwt`, `verifyJwt`, `getSession`, `getSSM` cacheado) compartido/Layer.
- [ ] `verifyJwt` fija `alg=HS256`, valida `iss/aud/exp/iat`, soporta `[current, previous]`.
- [ ] Cookies: `l4d2_oauth_state` (Lax, Path=/auth/steam, un solo uso) y `l4d2_session` (Lax,
      HttpOnly, Secure, Path=/, 7 d, renovación deslizante).
- [ ] `check_authentication` real contra Steam + regex estricta de `claimed_id` + `state`.
- [ ] `GetPlayerSummaries` con timeout 3 s + fallback.
- [ ] Upsert Usuario con `if_not_exists` para no pisar `operador`/`suspendido`.
- [ ] En `l4d2-api`: `getSession`, chequeo de `suspendido` en escrituras, `operador` en endpoints op,
      validación de `Origin`, header `X-Origin-Verify`, headers de seguridad.
- [ ] CloudFront: `CachingDisabled` + forward de Cookie/Origin/querystrings + `Set-Cookie` +
      `X-Origin-Verify` en `/api/*` y `/auth/*`; Response Headers Policy (§12.3).
- [ ] `GET /api/me` para bootstrap del SPA.
- [ ] Setear `operador=true` para el SteamID64 de Ventrax tras su primer login.

---

## 17. Preguntas abiertas / pendientes menores

- **Formato de respuesta de la Function URL v2** (`cookies: []` multi-cookie) asumido; confirmar al
  cablear el handler (con el "payload format version 2.0" de Function URLs es soportado).
- **Nombre real de la tabla y layout de claves** (A1): confirmar con el dominio de modelo-de-datos;
  si difiere, ajustar constantes de `upsertUsuario`/`getUsuario`.
- Decidir si `auth.js` va como **Lambda Layer** o bundleado en cada función (para 2 Lambdas hobby,
  bundlear es más simple; Layer si se prefiere una sola copia).
