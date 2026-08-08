# 05 · SourceBans++ y ruteo CloudFront → PC de casa

> Dominio de diseño: **sourcebans**. Cubre la MySQL/MariaDB local con SourceBans++, el fix de
> LAC/lilac para que los bans persistan, el panel PHP servido desde la PC, y todo el ruteo de
> CloudFront hacia el origen de casa (DNS dinámico, certificado del lado de casa, manejo de origen
> caído, wake-on-uso solo-operador, sostén de auto-apagado y seguridad del panel expuesto).
>
> Fuente de verdad de producto: `docs/especificaciones-v1.md` (§9, §13, §15). Base local: repo
> Ansible `~/modules/personal/l4d2-fleet/` (rol `l4d2_fleet`). Este documento es suficiente para
> implementar sin re-diseñar.

---

## 0. Datos fijos que este diseño usa (verificados)

| Recurso | Valor |
|---|---|
| Cuenta AWS | `211125402452`, perfil SSO `ventrax_infra_prod` |
| Región principal | `us-east-2` (Lambda, DynamoDB, SSM, EventBridge) |
| Región del cert de CloudFront | `us-east-1` (obligatorio para ACM de CF) |
| Zona Route53 (`ventrax.dev`) | `Z0798505KCA3V0GU54OJ` |
| Dominio de la plataforma | `l4d2.ventrax.dev` (SPA + API + `/sourcebans`) |
| Hostname DDNS del origen de casa | **`home.ventrax.dev`** (A dinámica, TTL 60s) |
| Host de casa (LAN) | `192.168.18.100`, usuario servicio `steam`, SSH en `:2222` (llave ed25519) |
| MAC WoL | `0A:E0:AF:AF:28:22` (dominio power/WoL, aquí solo se referencia) |
| Puertos de juego (UDP) | `6033..6036` (`port_base=6032` + N), ya forwarded |
| Install de juego compartido | `/home/steam/l4d2` (`INSTALL_DIR`); árbol real en `.../left4dead2/` |
| RCON (loopback) | `127.0.1.1:<port_de_juego>`, pass en `/etc/l4d2-fleet/fleet.env` |

**Puerto entrante NUEVO que introduce este dominio:** `TCP 443` (o `8443` si el ISP bloquea 443)
forwarded en el router hacia `192.168.18.100`. Es el **único** ingreso nuevo (además del UDP de
juego y el paquete WoL). Todo lo demás del panel es saliente o loopback.

---

## 1. Topología y flujo de request

```
  Navegador (jugador / operador)
        │  HTTPS  https://l4d2.ventrax.dev/sourcebans/...
        ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ CloudFront (1 distribución, cert ACM us-east-1 para l4d2.ventrax.dev)  │
  │                                                                        │
  │  behavior /*            → S3 (SPA, SIEMPRE viva)   [otro dominio]       │
  │  behavior /api/*        → Lambda FURL (API)        [otro dominio]       │
  │  behavior /auth/steam*  → Lambda FURL (login)      [otro dominio]       │
  │  behavior /sourcebans*  → ORIGEN "home"  ◄── ESTE DOMINIO              │
  │                            OriginRequestPolicy=AllViewer                │
  │                            CachePolicy=CachingDisabled                  │
  │                            custom header X-Origin-Verify: <secreto>     │
  │  customErrorResponses 502/503/504 → /despertando.html (200, TTL 3s)     │
  └───────────────┬──────────────────────────────┬────────────────────────┘
                  │ PC ENCENDIDA                  │ PC APAGADA (origen caído)
                  │ SNI=home.ventrax.dev          │ conexión falla → 502 en ~3-6s
                  ▼                               ▼
   TLS a home.ventrax.dev:443            /despertando.html (asset en S3, vía behavior /*)
   (LE cert de home.ventrax.dev)          hace polling + gating solo-operador del WoL
                  │
      Router de casa: WAN :443 ─────► 192.168.18.100:443
                  ▼
  ┌──────────────────────────────────────────────┐
  │ PC de casa (Ubuntu, usuario steam)             │
  │  nginx :443 (valida X-Origin-Verify)           │
  │   └─ /sourcebans/ → php-fpm (SourceBans++ web)  │
  │  MariaDB 127.0.0.1:3306  (DB "sourcebans")      │
  │  Flota l4d2@1..N  ── plugin sourcebans.smx ─────┼──► escribe/lee sb_bans
  │  LAC/lilac (lilac_sourcebans 1) ── vía SB++ ────┘
  │  Agente (heartbeat saliente + auto-apagado)     │
  └────────────────────────────────────────────────┘
```

Dos capas de TLS independientes: **viewer↔CloudFront** (cert ACM de `l4d2.ventrax.dev`, otro
dominio) y **CloudFront↔origen** (cert Let's Encrypt de `home.ventrax.dev`, este dominio). La
sesión del operador nunca viaja en claro.

---

## 2. Componente local — MariaDB + SourceBans++

### 2.1 Motor de base de datos

- **MariaDB** (paquete `mariadb-server` de Ubuntu; 10.6 en 22.04, 10.11 en 24.04). Alcanza de
  sobra; no hace falta MySQL Oracle.
- **`bind-address = 127.0.0.1`** (nunca expuesta). La usan solo: el plugin SB++ de la flota
  (localhost) y el panel PHP (localhost). No hay motivo para abrir 3306.
- DB y usuario dedicados (contraseña en `ansible-vault`):

```sql
CREATE DATABASE sourcebans CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'sourcebans'@'localhost' IDENTIFIED BY '<vault: sourcebans_db_password>';
GRANT ALL PRIVILEGES ON sourcebans.* TO 'sourcebans'@'localhost';
FLUSH PRIVILEGES;
```

### 2.2 SourceBans++ (versión y esquema)

- **SourceBans++** (fork mantenido `sbpp/sourcebans-pp`), release estable **1.8.x**. Es el
  reemplazo vivo del SourceBans clásico (el clásico está muerto). Dos artefactos por release:
  - `sourcebans-pp-<ver>-web-only.tar.gz` → carpeta `web/` (PHP) → va a `/var/www/sourcebans`.
  - `sourcebans-pp-<ver>-plugin-only.tar.gz` → árbol `addons/sourcemod/` (plugins `.smx`, sources,
    `configs/`, `translations/`, `gamedata/`) → se copia sobre el árbol de juego compartido.
- **Esquema:** lo crea el **instalador web** (`/sourcebans/install/`) en la primera corrida; usa
  prefijo `sb` por defecto. Tablas clave (no exhaustivo, el instalador arma todas):

  | Tabla | Para qué |
  |---|---|
  | `sb_bans` | bans (SteamID/IP, motivo, admin, servidor, longitud, tiempo) — **acá aterrizan los de LAC y del operador** |
  | `sb_admins` | admins web/juego (login por Steam OpenID nativo del panel) |
  | `sb_srvgroups`, `sb_admins_servers_groups` | grupos/permisos de admin |
  | `sb_servers` | servidores registrados (IP:puerto) — 4 filas, una por 6033..6036 |
  | `sb_settings` | config del panel |
  | `sb_comments`, `sb_banlog`, `sb_demos`, `sb_protests` | comentarios, log de bans, demos, protestas |

- **PHP:** SB++ 1.8.x corre en PHP **7.4–8.2**. Objetivo **php8.1-fpm** (default de Ubuntu 22.04).
  En 24.04 (php8.3) usar la rama que soporte 8.3 o el PPA `ondrej/php` con `php8.1`. Extensiones:
  `php8.1-fpm php8.1-mysql php8.1-gd php8.1-mbstring php8.1-xml php8.1-curl php8.1-zip php8.1-intl`.

### 2.3 Plugin de juego SB++ e integración con la flota

- Copiar del `plugin-only` a `.../left4dead2/addons/sourcemod/`: `plugins/sourcebans.smx`,
  `plugins/sbpp_checker.smx` (opcional), `configs/sourcebans/*`, `translations/*`, `gamedata/*`.
  Como el install es **compartido** (§8 del reconocimiento), una sola copia cubre `l4d2@1..N`.
- **`databases.cfg`** (`.../addons/sourcemod/configs/databases.cfg`) — agregar la sección
  `"sourcebans"` (nombre que el plugin busca), templada por Ansible desde vault:

```
"sourcebans"
{
    "driver"    "mysql"
    "host"      "127.0.0.1"
    "database"  "sourcebans"
    "user"      "sourcebans"
    "pass"      "<vault: sourcebans_db_password>"
    "port"      "3306"
}
```

- **Config del plugin** (`.../addons/sourcemod/configs/sourcebans/sourcebans.cfg`): `DatabasePrefix
  "sb"`, `Website "l4d2.ventrax.dev/sourcebans"`, `ServerID "-1"` (auto por IP:puerto),
  `BackupConfigs "1"`. El resto en defaults.
- **Registro de servidores** (`sb_servers`): 4 filas `ip=192.168.18.100`, `port=6033..6036`, vía
  el panel (Admin → Servers → Add) o `INSERT` seed. **Ojo:** la enforcement de bans es **global por
  SteamID** y funciona aunque el registro por-servidor sea imperfecto (el kick al conectar solo
  necesita que el plugin consulte la DB). El registro es para atribución/estadística. Si SB++ loguea
  "server not registered" ajustar el `ip` al que reporta el server (LAN vs pública tras NAT).
- **Persistencia entre matchmode (opcional, recomendado):** `predictable_unloader.sp` (fork de la
  flota, array `gKeep[][]`) hoy reserva `chat_logger.smx`, `admin_manager.smx`, `idle_hibernate.smx`.
  Para que la enforcement de bans no tenga ventana durante `!match`/`!unmatch`, **agregar
  `"sourcebans.smx"` a `gKeep` y recompilar**. Marcado **opcional**: el chequeo real de ban ocurre
  al conectar (fuera del match) y los bans son globales, así que la ventana es despreciable. No
  bloquea v1.

### 2.4 Fix de LAC / lilac (que los bans persistan)

Hoy `lilac_sourcebans 1` y `lilac_ban_length 0` ya están puestos, pero **no había ni DB ni plugin
SB++**, así que lilac "baneaba a la nada". El fix es exactamente §2.1–§2.3 **más** garantizar que
lilac tenga a quién delegar:

- lilac, con `lilac_sourcebans 1`, **rutea el ban a través de SourceBans** (usa el plugin
  `sourcebans.smx`; no escribe SQL por su cuenta). Por eso el fix central es **instalar
  `sourcebans.smx` + `databases.cfg`**; hecho eso, lilac ya persiste.
- Confirmar/forzar los dos cvars en el cfg de lilac (viene con ZoneMod, no con el repo Ansible;
  ruta típica `.../left4dead2/cfg/sourcemod/little_anti_cheat.cfg`, autogenerado por
  AutoExecConfig). Ansible los fija idempotente:

```
lilac_sourcebans "1"      // rutea bans por SourceBans (no ban local)
lilac_ban_length "0"      // permanente
```

- Orden de carga: `sourcebans.smx` debe estar cargado cuando lilac banea. Ambos son plugins normales
  del árbol compartido; con SourceMod cargando `plugins/` al arrancar quedan disponibles. (Si se
  agrega `sourcebans.smx` a `gKeep`, §2.3, también sobrevive matchmode.)
- **Operador banea** con `sm_ban` (flag `d`, que su entrada root `z` en `admins_simple.ini` ya
  cubre) → SB++ hookea `sm_ban` → `sb_bans`. **El reservador NO** (su admin por-servidor recibe solo
  flags de kick/changemap `c,g`, sin `d`; eso lo define el dominio de admin-por-servidor).

---

## 3. Panel PHP — nginx + php-fpm

### 3.1 Layout

- Web root del panel: **`/var/www/sourcebans`** (contenido del `web-only`). Se sirve bajo el
  sub-path **`/sourcebans`** para que la URL pública sea `l4d2.ventrax.dev/sourcebans`.
- Truco de mapeo directo (sin reescrituras raras): `root /var/www;` y la carpeta se llama
  `sourcebans`, así `/sourcebans/index.php` → `/var/www/sourcebans/index.php` 1:1.
- php-fpm pool `www-data`, socket `/run/php/php8.1-fpm.sock`, `pm = ondemand` con pocos hijos
  (tráfico mínimo, ahorra RAM en una PC que también corre 4 srcds).
- SB++ `config.php` con `website` base = `https://l4d2.ventrax.dev/sourcebans` (para que los enlaces
  absolutos que genere apunten al dominio público, no al de origen).

### 3.2 vhost nginx (`/etc/nginx/sites-available/sourcebans.conf`)

```nginx
# El secreto compartido con CloudFront (custom origin header). Solo pasa quien lo trae.
map $http_x_origin_verify $origin_ok {
    default 0;
    "<vault: sourcebans_origin_verify_secret>" 1;
}

# Solo cuentan como "actividad de panel" (sostén #3) las navegaciones dinámicas,
# no los assets estáticos ni el health. El agente lee la frescura de este log.
map $request_uri $sb_sosten {
    default 1;
    "~*\.(css|js|png|jpe?g|gif|svg|ico|woff2?)(\?|$)" 0;
    "~*^/sourcebans/health"                            0;
}

log_format sbpanel '$time_iso8601 $status $request_method $request_uri';

server {
    listen 443 ssl http2 default_server;
    server_name l4d2.ventrax.dev home.ventrax.dev;   # SNI de CF = home.*; Host reenviado = l4d2.*

    ssl_certificate     /etc/letsencrypt/live/home.ventrax.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/home.ventrax.dev/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    server_tokens off;
    client_max_body_size 8m;                 # SB++ sube demos/pruebas
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN   always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    # Rechaza todo lo que NO venga por CloudFront (scan directo a la IP de casa)
    if ($origin_ok = 0) { return 403; }

    root /var/www;
    index index.php;

    location = /sourcebans/health { default_type text/plain; return 200 "ok\n"; }

    location /sourcebans/ {
        access_log /var/log/nginx/sourcebans_panel.log sbpanel if=$sb_sosten;
        try_files $uri $uri/ /sourcebans/index.php?$query_string;

        location ~ ^/sourcebans/.+\.php$ {
            include fastcgi_params;
            fastcgi_pass unix:/run/php/php8.1-fpm.sock;
            fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
            fastcgi_read_timeout 30s;
        }
    }

    location / { return 404; }   # el origen no sirve nada fuera de /sourcebans
}
```

Notas:
- `Host` reenviado por CloudFront (`AllViewer`) = `l4d2.ventrax.dev`, así PHP genera redirects
  limpios. El **SNI** que usa CF sigue siendo el *origin domain* `home.ventrax.dev`, que matchea el
  cert LE. Por eso `server_name` incluye ambos y el bloque es `default_server`.
- El `X-Origin-Verify` lo **inyecta CloudFront** como custom origin header; si un viewer lo manda,
  CloudFront lo **sobrescribe** (los custom origin headers ganan). Nombre poco común a propósito.
- `if (...) return 403;` a nivel server es uno de los usos seguros de `if` en nginx.

### 3.3 Health / readiness para el agente

El agente NO usa HTTP para el readiness (evita ensuciar el log de sostén). Chequea local:

```
sourcebans_ready = systemctl is-active --quiet nginx php8.1-fpm mariadb \
                   && mysqladmin --defaults-file=/etc/l4d2-fleet/sb-mysql.cnf ping | grep -q alive
```

Ese booleano viaja en el heartbeat (`sourcebansReady`) y lo expone `/api/host/state` para que la
página "despertando" sepa cuándo redirigir.

---

## 4. Certificado del lado de casa (Let's Encrypt para `home.ventrax.dev`)

CloudFront **exige** que el cert del origen sea de una CA pública y matchee el origin domain; no
acepta self-signed. Por eso el origen necesita un cert LE real para `home.ventrax.dev`.

### 4.1 Método: DNS-01 vía Route53 (elegido)

- **`certbot` + plugin `python3-certbot-dns-route53`**. DNS-01 no necesita puerto 80 abierto ni que
  la PC sea alcanzable durante la emisión → mantiene cerrado el 80 (menor superficie).
- Emisión inicial (la corre Ansible una vez):

```
certbot certonly --dns-route53 \
  --dns-route53-propagation-seconds 30 \
  -d home.ventrax.dev \
  -m alonsolgm001@gmail.com --agree-tos --non-interactive
# Cert en /etc/letsencrypt/live/home.ventrax.dev/{fullchain,privkey}.pem
```

### 4.2 Credenciales AWS acotadas en la PC

Un **IAM user dedicado `l4d2-home-certbot`** (solo para el TXT de ACME), sus llaves en
`/etc/l4d2-fleet/route53-certbot.env` (`0600 root:root`, desde vault), referenciado por las units de
cert. Política **estrechada al record `_acme-challenge.home.ventrax.dev` TXT** con las condition
keys de Route53:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["route53:ListHostedZones", "route53:GetChange"], "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": "route53:ChangeResourceRecordSets",
      "Resource": "arn:aws:route53:::hostedzone/Z0798505KCA3V0GU54OJ",
      "Condition": {
        "ForAllValues:StringEquals": {
          "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["_acme-challenge.home.ventrax.dev"],
          "route53:ChangeResourceRecordSetsRecordTypes": ["TXT"]
        }
      }
    }
  ]
}
```

Con eso, aunque se filtren esas llaves, solo permiten tocar el TXT de ACME de ese subdominio: no
pueden mover la A del DDNS ni nada más. (La **A `home.ventrax.dev` la mantiene el backend**, §7, no
la PC.)

### 4.3 Renovación robusta con PC intermitente

La PC está casi siempre apagada, así que la renovación se ancla a los **arranques**:

- `certbot.timer` (systemd, 2×/día) intenta renovar cuando la PC esté viva.
- **Oneshot al boot** `l4d2-cert-renew.service` (`After=network-online.target`,
  `EnvironmentFile=/etc/l4d2-fleet/route53-certbot.env`) corre
  `certbot renew --quiet --deploy-hook "systemctl reload nginx"` en cada encendido → en cualquier
  ventana de renovación (cert de 90d, LE renueva a los 60, ventana de 30d) la PC se enciende al menos
  una vez (el operador juega/administra) y renueva. El `deploy-hook` recarga nginx con el cert nuevo.

**Fallback documentado (no elegido): HTTP-01.** Evitaría llaves AWS en la PC, pero exige forward del
puerto 80 y que la PC esté encendida y alcanzable durante la renovación. Se descarta para no abrir el
80; DNS-01 con llaves acotadas es más limpio.

---

## 5. Ruteo CloudFront (behavior + origen `home`)

Se agrega a la **distribución existente** de `l4d2.ventrax.dev` (definida por el dominio infra/CDK):
un **origen custom** y un **behavior** `/sourcebans*`. El cert ACM del viewer (us-east-1,
`l4d2.ventrax.dev`) y los otros behaviors son de otros dominios; acá solo se añade lo del panel.

### 5.1 Origen `home`

| Prop | Valor | Por qué |
|---|---|---|
| Domain name | `home.ventrax.dev` | DDNS que resuelve a la IP de casa |
| Protocol policy | **HTTPS only** | no mandar la sesión del operador en claro |
| HTTPS port | `443` (`8443` si el ISP bloquea 443) | puerto forwarded en el router |
| Origin SSL protocols | `TLSv1.2` | |
| Connection timeout | **3 s** | que un origen caído falle rápido → página "despertando" |
| Connection attempts | **2** | ~6 s peor caso antes del 502 |
| Read timeout | 30 s | PHP del panel |
| Custom header | `X-Origin-Verify: <secreto SSM>` | nginx rechaza lo que no lo traiga |

### 5.2 Behavior `/sourcebans*`

| Prop | Valor |
|---|---|
| Path pattern | `/sourcebans*` (cubre `/sourcebans` y `/sourcebans/...`; el bare redirige a `/sourcebans/`) |
| Origin | `home` |
| Viewer protocol | `redirect-to-https` |
| Allowed methods | `ALL` (GET/HEAD/OPTIONS/PUT/POST/PATCH/DELETE — login y acciones admin son POST) |
| Cache policy | **`CachingDisabled`** (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`) — panel dinámico |
| Origin request policy | **`AllViewer`** (`216adef6-5c7f-47e4-b989-5492eb8f8c9e`) — reenvía Host, cookies (`PHPSESSID`), query strings y headers |
| Compress | true |

### 5.3 Manejo de origen caído → página "despertando"

**Custom Error Responses a nivel distribución** (elegido por simplicidad; sin orígenes extra):

| HTTP error del origen | ResponsePagePath | ResponseCode | ErrorCachingMinTTL |
|---|---|---|---|
| 502 | `/despertando.html` | 200 | 3 s |
| 503 | `/despertando.html` | 200 | 3 s |
| 504 | `/despertando.html` | 200 | 3 s |

`/despertando.html` es un asset estático en el bucket S3 de la SPA (se sirve por el behavior `/*`),
así que está disponible **aunque la PC esté apagada**. Cuando la PC está off, CF no conecta al origen
→ 502 en ~3-6 s → sirve la página "despertando".

**Caveat asumido (dependencia del dominio API):** las Custom Error Responses son globales a la
distribución, así que un 5xx del Lambda de `/api/*` también mostraría la página. Se acepta porque la
API está diseñada para responder **200 con envelope JSON** (los errores van en el body), de modo que
un 5xx crudo es excepcional. *Alternativa más acotada (documentada, no elegida):* un **Origin Group**
{primario=`home`, secundario=S3-waking} con failover en 502/503/504 — resuelve el scoping por behavior
pero agrega un origen y un bucket/errdoc; sobra para hobby.

### 5.4 CDK (TypeScript, añadidos)

```ts
// Secreto compartido con el origen. Es un filtro anti-scan, no protege datos
// (eso lo hacen TLS + auth de SB++), así que va como SSM String param.
const originVerify = ssm.StringParameter.valueForStringParameter(
  this, '/l4d2-panel/prod/origin-verify');

const homeOrigin = new origins.HttpOrigin('home.ventrax.dev', {
  protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY,
  httpsPort: 443,
  originSslProtocols: [cf.OriginSslPolicy.TLS_V1_2],
  connectionTimeout: Duration.seconds(3),
  connectionAttempts: 2,
  readTimeout: Duration.seconds(30),
  customHeaders: { 'X-Origin-Verify': originVerify },
});

distribution.addBehavior('/sourcebans*', homeOrigin, {
  viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  allowedMethods: cf.AllowedMethods.ALLOW_ALL,
  cachePolicy: cf.CachePolicy.CACHING_DISABLED,
  originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER,
  compress: true,
});

// A nivel Distribution props:
errorResponses: [
  { httpStatus: 502, responsePagePath: '/despertando.html', responseHttpStatus: 200, ttl: Duration.seconds(3) },
  { httpStatus: 503, responsePagePath: '/despertando.html', responseHttpStatus: 200, ttl: Duration.seconds(3) },
  { httpStatus: 504, responsePagePath: '/despertando.html', responseHttpStatus: 200, ttl: Duration.seconds(3) },
]
```

---

## 6. Wake-on-uso restringido al OPERADOR

Requisito (§9 spec): si la PC está apagada y **el operador** entra a `/sourcebans`, se dispara el
mismo WoL que una reserva; **un visitante NO** puede prender la PC pegándole a la URL.

### 6.1 La página `/despertando.html` (lógica)

La página que sirve la Custom Error Response no dispara WoL sola; **gatea por rol** y el WoL real lo
autoriza el backend (el ocultar/mostrar el botón es solo UX; la barrera es server-side).

```
onLoad():
  render("Despertando el servidor…")  # stepper: DESPERTANDO → INICIANDO → VERIFICANDO → LISTO
  s = await GET /api/host/state          # {pc:"off|booting|online", sourcebansReady, wakeInProgress}
  me = await GET /api/session            # {authenticated, operador}   (o decodificar el JWT local)

  if s.pc == "online" and s.sourcebansReady:
      location.replace("/sourcebans/"); return          # ya está viva → al panel

  if not me.operador:
      render("El panel de administración solo lo enciende el operador.")
      return                                             # ← NO se dispara WoL

  # operador:
  if not s.wakeInProgress:
      await POST /api/wake { reason: "sourcebans" }      # el backend RE-verifica operador

  every 4s:
      s = await GET /api/host/state
      updateStepper(s)
      if s.pc == "online" and s.sourcebansReady:
          location.replace("/sourcebans/")
```

### 6.2 Contrato del endpoint de WoL (se **reusa** el del dominio power/WoL)

```
POST /api/wake   Authorization: Bearer <JWT>   body:{ reason: "reserva" | "sourcebans" }
  1. Verificar JWT.                              # sin sesión → 401
  2. if reason == "sourcebans" and not user.operador: return 403   # ← el gating REAL
  3. Registrar/confirmar intent de encendido (host domain), mandar WoL, set Host.wakeInProgress.
  4. return 202 { status: "waking" }
```

- El gating de verdad es el **paso 2, en el backend**: `reason:"sourcebans"` exige `operador`. Un
  visitante sin sesión recibe 401; un jugador logueado sin flag recibe 403. Nadie enciende la PC por
  la URL de sourcebans salvo el operador.
- `reason:"reserva"` sigue disponible para cualquier jugador autenticado (reservar ya enciende la
  PC); eso lo maneja el dominio de reservas. El único `reason` operador-only es `"sourcebans"`.

> **Supuesto declarado:** existen `POST /api/wake`, `GET /api/host/state`, `GET /api/session` (o el
> JWT expone `operador`) provistos por los dominios auth / host-agent / WoL. Este documento fija el
> **contrato** que necesita (el `reason` y la verificación `operador`), no su implementación.

### 6.3 Login del panel una vez despierto

- El panel SB++ tiene su **propio login por Steam OpenID (nativo de SB++)**. El operador entra con
  Steam; su SteamID se da de alta como **Web Super Admin** en SB++ (Admins → Add, grupo con permiso
  web). Es independiente del flag `operador` de DynamoDB (ese solo gatea el *wake*).
- La **lista de bans es pública de lectura** (comportamiento normal de un panel SourceBans); las
  acciones privilegiadas exigen el login SB++. Que el panel sea alcanzable cuando la PC ya está
  encendida por otra razón (una partida) es **aceptado y esperado** — lo único operador-only es
  *encenderla*.

---

## 7. DNS dinámico — mantener `home.ventrax.dev`

La IP pública de casa es dinámica. `home.ventrax.dev` (A, TTL 60s) debe seguirla.

### 7.1 Mecanismo elegido: el **backend** la actualiza por la IP de origen del heartbeat

El agente ya hace heartbeat HTTPS saliente (~10-15s). El **Lambda de heartbeat lee la IP de origen
del propio request** (`event.requestContext.http.sourceIp` en la Function URL) — el agente **no
necesita detectar su IP ni tener llaves AWS**.

```
handler POST /api/agent/heartbeat:               # dominio host-agent; acá se fija el contrato
    src = event.requestContext.http.sourceIp
    host = ddb.get(HOST)
    if host.publicIp != src:
        route53.changeResourceRecordSets(
            HostedZoneId = "Z0798505KCA3V0GU54OJ",
            Change = UPSERT home.ventrax.dev A 60  -> src)
        ddb.update HOST.publicIp = src
    ddb.update HOST.lastHeartbeat, HOST.sourcebansReady = body.sourcebansReady, ...
```

- Solo llama a Route53 **cuando la IP cambia** (compara contra `HOST.publicIp` en DynamoDB) → sin
  churn ni costo. Con TTL 60s, tras un cambio de IP CloudFront reintenta el origen y en ≤1 min
  resuelve la nueva. Un fallo transitorio mientras propaga = página "despertando", se auto-recupera.
- Las credenciales viven **server-side** (el rol del Lambda tiene `route53:ChangeResourceRecordSets`
  sobre la zona). Separación limpia con el user acotado de certbot (§4.2), que solo toca el TXT.

> **Supuesto:** la IP que ve el Lambda es la pública real de casa (no CGNAT). El WoL desde internet
> ya funciona (reconocimiento), lo que confirma IP pública alcanzable + port-forward, así que el
> supuesto se sostiene. Si hubiera CGNAT, el forward entrante del panel tampoco funcionaría → habría
> que un túnel, fuera de alcance.

### 7.2 Rol IAM del Lambda de heartbeat (añadido)

```json
{ "Effect": "Allow",
  "Action": ["route53:ChangeResourceRecordSets"],
  "Resource": "arn:aws:route53:::hostedzone/Z0798505KCA3V0GU54OJ",
  "Condition": { "ForAllValues:StringEquals": {
      "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["home.ventrax.dev"],
      "route53:ChangeResourceRecordSetsRecordTypes": ["A"] } } }
```

Más `route53:GetChange` (`*`) si se espera propagación. (Lo aplica el dominio host-agent en su
Lambda; acá se especifica.)

### 7.3 Alternativa documentada (no elegida): `ddclient` en la PC

`ddclient` (o `certbot`-style script) con provider Route53 + IAM user acotado a la A. Se descarta
porque pondría **más credenciales AWS en la PC** y la IP solo se refresca cuando la PC está viva
(justo cuando importa que esté al día para que CF la alcance). El approach por-heartbeat lo cubre sin
llaves en la caja. Se mantiene como fallback si la IP de origen vista por el Lambda resultara poco
fiable (p.ej. IPv6/XFF).

---

## 8. SourceBans como sostén #3 del auto-apagado

Spec §7: sostén #3 = "SourceBans usado en los últimos 10 min". El agente lo detecta por el **access
log del panel** (§3.2, `sourcebans_panel.log`, que ya excluye assets estáticos y el health).

```
def sosten_sourcebans_activo(now):
    log = "/var/log/nginx/sourcebans_panel.log"
    if not exists(log): return False
    # cada línea: "<time_iso8601> <status> <method> <uri>"; basta la última entrada relevante
    ultima = ultima_linea(log)                 # o mtime del archivo (equivalente barato)
    if ultima is None: return False
    return (now - parse_iso8601(ultima.time)) < 600   # 10 min
```

- El log **solo** registra navegación dinámica del panel llegada por CloudFront (las peticiones sin
  `X-Origin-Verify` se cortan con 403 antes por el `if`, y no se loguean aquí; los assets/health se
  excluyen con `if=$sb_sosten`). Así un scan directo a la IP **no** cuenta como sostén.
- Cuando la PC está apagada el panel no es alcanzable, así que este sostén solo puede activarse con la
  PC ya encendida → no interfiere con el gating de wake (§6).
- **Endurecimiento opcional:** para contar solo actividad *autenticada* (no un visitante ojeando la
  lista pública), agregar `$cookie_PHPSESSID` al `log_format` y exigir su presencia. Innecesario para
  v1 (que un visitante mantenga viva la PC 10 min extra es costo trivial y solo ocurre si ya estaba
  encendida).

> **Supuesto:** el bucle de auto-apagado del agente (dominio host-agent) agrega los 4 sostenes (§7
> spec) y hace `poweroff` cuando ninguno aplica. Este documento aporta **solo la fuente de datos y el
> chequeo del sostén #3**.

---

## 9. Seguridad del panel expuesto (checklist)

| Control | Cómo |
|---|---|
| **TLS extremo a extremo** | viewer↔CF (ACM `l4d2.ventrax.dev`) + CF↔origen (LE `home.ventrax.dev`, HTTPS-only). Sesión del operador nunca en claro. |
| **Solo por CloudFront** | `X-Origin-Verify` (custom origin header) → nginx 403 sin él. Un scan directo a `home.ventrax.dev:443` no pasa del 403. |
| **MySQL no expuesta** | `bind-address=127.0.0.1`; solo localhost. |
| **Superficie mínima en nginx** | el origen sirve **solo** `/sourcebans/*`; el resto 404. `server_tokens off`. Headers `nosniff`/`X-Frame-Options`/`Referrer-Policy`. `client_max_body_size 8m`. |
| **Auth del panel** | login SB++ por Steam OpenID nativo; acciones admin requieren sesión SB++. Lista de bans pública de lectura (normal). |
| **Instalador bloqueado** | tras instalar SB++, borrar/`chmod 000` `/var/www/sourcebans/install`. `display_errors=Off` en php-fpm. |
| **Wake gateado** | encender la PC vía `/sourcebans` exige `operador` (server-side, §6.2). |
| **Secreto de origen** | 32 bytes aleatorios; rotarlo = actualizar SSM `/l4d2-panel/prod/origin-verify` + `nginx`; ambos lados deben coincidir. |
| **firewall (ufw)** | permitir `443/tcp` (panel), `6033:6036/udp` (juego), SSH `2222` desde LAN; denegar el resto; 3306 nunca. |
| **(opcional) allowlist CF** | restringir `443/tcp` a los prefijos `CLOUDFRONT_ORIGIN_FACING` de `ip-ranges.json` (el agente refresca ufw 1×/semana). Defensa en profundidad; el `X-Origin-Verify` ya es el control primario. |
| **(opcional) rate-limit login** | `limit_req` sobre la IP real (requiere `set_real_ip_from` con rangos CF + `X-Forwarded-For`). Bajo valor tras CF; SB++ ya throttlea. |
| **Sin AWS WAF** | cuesta ~$5-6/mes; **se descarta** para hobby. El header secreto + auth SB++ + TLS bastan. |

---

## 10. Cambios en el repo Ansible `l4d2-fleet`

Todo se agrega al rol existente `l4d2_fleet` (el componente local "extiende la flota"). Gated por
`with_sourcebans | bool` (default `true`).

### 10.1 Nuevo archivo de tareas `roles/l4d2_fleet/tasks/sourcebans.yml`

Importado desde `tasks/main.yml` **después** de `fleet.yml` (necesita el árbol de juego y
`fleet.env`). Pasos idempotentes:

1. `apt`: `mariadb-server`, `nginx`, `php8.1-fpm` + extensiones (§2.2), `certbot`,
   `python3-certbot-dns-route53`.
2. MariaDB: `bind-address=127.0.0.1`; crear DB `sourcebans` + user (vault); `mysql_secure`-equivalente.
3. Descargar/extraer SB++ **web** a `/var/www/sourcebans` (owner `www-data`), **plugin** al árbol de
   juego (owner `steam`); template `databases.cfg` (sección `sourcebans`, vault) y
   `configs/sourcebans/sourcebans.cfg`.
4. LAC/lilac: `lineinfile` de `lilac_sourcebans "1"` y `lilac_ban_length "0"` en
   `cfg/sourcemod/little_anti_cheat.cfg`.
5. Secreto de origen: `lookup('amazon.aws.aws_ssm', '/l4d2-panel/prod/origin-verify', region='us-east-2')`
   → variable → template del `map` de nginx (única fuente de verdad, compartida con CDK).
6. Credenciales certbot: template `/etc/l4d2-fleet/route53-certbot.env` (`0600 root`, vault).
7. Cert LE: `certbot certonly --dns-route53 -d home.ventrax.dev` (`creates:` el fullchain para
   idempotencia); instalar unit oneshot `l4d2-cert-renew.service` (§4.3).
8. nginx: copiar `sourcebans.conf` (template con el secreto), `nginx -t`, habilitar sitio, handler
   `restart nginx`.
9. php-fpm: `pm=ondemand`, `display_errors=Off`; handler `restart php8.1-fpm`.
10. (opcional) recompilar `predictable_unloader.smx` con `sourcebans.smx` en `gKeep` (§2.3) — o dejar
    nota manual, ya que requiere `spcomp`.

### 10.2 Variables nuevas (`defaults/main.yml`)

```yaml
with_sourcebans: true
sourcebans_version: "1.8.0"
sourcebans_web_dir: /var/www/sourcebans
sourcebans_db_name: sourcebans
sourcebans_db_user: sourcebans
sourcebans_origin_domain: home.ventrax.dev
sourcebans_origin_port: 443           # 8443 si el ISP bloquea 443
sourcebans_route53_zone_id: Z0798505KCA3V0GU54OJ
sourcebans_le_email: alonsolgm001@gmail.com
# Secretos → ansible-vault (group_vars) o lookup SSM en runtime:
# sourcebans_db_password, sourcebans_origin_verify_secret,
# route53_certbot_access_key_id, route53_certbot_secret_access_key
```

### 10.3 Handlers nuevos (`handlers/main.yml`)

`restart nginx`, `restart php8.1-fpm`, `restart mariadb`, `reload nginx`.

---

## 11. Runbook de despliegue (primera vez, en orden)

1. **SSM** (us-east-2): crear param `/l4d2-panel/prod/origin-verify` (String) con 32 bytes aleatorios.
2. **IAM**: crear user `l4d2-home-certbot` + política acotada (§4.2); guardar llaves en vault.
3. **Route53**: crear `home.ventrax.dev` A → IP pública actual de casa, TTL 60 (bootstrap; luego la
   mantiene el backend, §7).
4. **Router de casa**: forward `TCP 443` WAN → `192.168.18.100:443`.
5. **Ansible**: `ansible-playbook playbook.yml` → provisiona MariaDB, PHP, nginx, cert LE, SB++
   web+plugin, `databases.cfg`, cvars de lilac, secreto en nginx, units de cert.
6. **CDK**: desplegar el origen `home` + behavior `/sourcebans*` + policies + custom error responses
   + (dominio host-agent) el permiso Route53 A en el rol de heartbeat. Subir `/despertando.html` al
   bucket SPA.
7. **Instalador SB++** (PC encendida): abrir `https://l4d2.ventrax.dev/sourcebans/install/`, crear el
   esquema apuntando a `127.0.0.1`/`sourcebans`. Luego **borrar/`chmod 000`** `install/`.
8. **SB++ admin**: entrar por Steam, dar al SteamID del operador **Web Super Admin**; registrar los 4
   servidores (`192.168.18.100:6033..6036`).
9. **Verificar**: LAC banea a un test → aparece en `sb_bans`; el operador banea con `sm_ban` → aparece;
   apagar la PC → hit a `/sourcebans` muestra "despertando"; operador dispara wake y entra; visitante
   sin sesión ve el mensaje sin encender nada.

---

## 12. Decisiones (ADR de este dominio)

- **DNS-01 (Route53) para el cert LE del origen**, no HTTP-01 → no abrir puerto 80; llaves AWS en la
  PC acotadas al solo TXT de `_acme-challenge.home.ventrax.dev`.
- **La A del DDNS la mantiene el backend por la IP de origen del heartbeat**, no `ddclient` → cero
  llaves AWS en la PC para el DDNS; refresca solo al cambiar la IP.
- **Origen caído → Custom Error Responses (502/503/504 → `/despertando.html`)**, no Origin Group → cero
  orígenes/buckets extra; caveat aceptado por el envelope-JSON de la API.
- **`X-Origin-Verify` (header secreto) como control primario anti-scan**, no AWS WAF ni allowlist de
  IPs de CF → costo $0, esfuerzo mínimo; WAF/allowlist quedan opcionales.
- **Wake-on-uso gateado en el backend (`reason:"sourcebans"` exige `operador`)**, no en el cliente →
  el ocultar el botón es UX; la barrera es server-side.
- **`AllViewer` + Host reenviado**, con SNI = origin domain → PHP genera redirects a `l4d2.ventrax.dev`
  sin filtrar `home.ventrax.dev`, y el cert LE (de `home.*`) sigue matcheando el SNI.
- **Enforcement de bans es global por SteamID**; reservar `sourcebans.smx` en `gKeep` es opcional.

### Qué se descarta por no sobre-ingenierizar
AWS WAF; Origin Group + bucket de fallback; `fail2ban`; rate-limit por IP real tras CF; allowlist de
prefijos CF en ufw; contar sostén solo-autenticado; MySQL Oracle (basta MariaDB); túnel/reverse-proxy
para el origen (con IP pública real el port-forward alcanza).

---

## 13. Supuestos y dependencias sobre otros dominios

1. **infra/CDK**: existe la distribución CloudFront de `l4d2.ventrax.dev` con su cert ACM
   (us-east-1) y los behaviors `/*`, `/api/*`, `/auth/steam*`. Este dominio **añade** el origen
   `home`, el behavior `/sourcebans*`, sus policies y las custom error responses.
2. **front/SPA**: el bucket S3 sirve **`/despertando.html`** (§5.3/§6.1) como asset estático
   siempre disponible.
3. **auth**: hay JWT de sesión propio con claim/flag **`operador`** consultable (`GET /api/session`
   o decodificable en cliente) y verificable server-side.
4. **WoL/power**: existe **`POST /api/wake`**; este dominio requiere que acepte
   `reason:"sourcebans"` y **exija `operador`** para ese reason.
5. **host-agent**: existe **`GET /api/host/state`** ({`pc`,`sourcebansReady`,`wakeInProgress`}) y el
   **heartbeat** que (a) reporta `sourcebansReady` desde el chequeo local (§3.3) y (b) el Lambda que
   lo recibe actualiza la A `home.ventrax.dev` por la IP de origen (§7) y agrega el **sostén #3**
   (§8) a su bucle de auto-apagado.
6. **data-model (DynamoDB)**: la entidad `Host` guarda `publicIp`, `lastHeartbeat`, `sourcebansReady`,
   `wakeInProgress`.
7. **admin-por-servidor**: el reservador recibe flags `c,g` (kick/changemap) **sin `d`** → no puede
   banear (consistente con D3).
8. **Red de casa**: IP pública real (no CGNAT), `443/tcp` forwardable. Confirmado indirectamente por
   el WoL-desde-internet funcionando.

### Preguntas abiertas
- ¿La IP que ve el Lambda FURL en el heartbeat es la pública de casa de forma estable (IPv4)? Si el
  agente sale por IPv6 o hay proxies, usar el fallback `ddclient` (§7.3).
- ¿El ISP permite inbound en `443`? Si no, cambiar a `8443` (`sourcebans_origin_port` + `httpsPort`
  del origen CF).
- ¿La rama de SB++ 1.8.x soporta el PHP del OS objetivo final (8.1 en 22.04 vs 8.3 en 24.04)? Fijar
  `php8.1` vía PPA si se queda en 24.04 y la rama estable aún no cubre 8.3.
- ¿El `ip` que reporta el plugin SB++ para `sb_servers` es la LAN (`192.168.18.100`) o la pública?
  Verificar en el primer arranque y ajustar las 4 filas (no bloquea la enforcement, que es global).
