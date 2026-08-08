# 06 — Infraestructura AWS (CDK / TypeScript)

> Diseño técnico del **proyecto CDK** que define TODA la infraestructura AWS de L4D2 Panel:
> recursos, propiedades clave, estructura del proyecto, stacks, parametrización y convención de
> nombres. **Alcance de ESTE documento:** SOLO recursos y estructura. Los **costos detallados** y el
> **procedimiento de despliegue** (bootstrap paso a paso, CI, publicación de la SPA) viven en otros
> documentos de `docs/tecnico/`. Aquí se mencionan propiedades con impacto de costo (25/25, retención
> de logs, budget) porque **condicionan el diseño**, no para desglosar la factura.
>
> Fuente de verdad de producto: `docs/especificaciones-v1.md`. Este doc materializa §5, §13 y §14.

---

## 0. Índice

1. Alcance, supuestos y dependencias entre dominios
2. Cuenta, regiones y bootstrap
3. Estructura de carpetas del proyecto CDK (`infra/`)
4. Parametrización por *context* (`cdk.json` + `config.ts`)
5. Stacks y `crossRegionReferences` (diagrama)
6. Inventario de recursos (propiedades clave, servicio por servicio)
7. IAM: roles y permisos mínimos por Lambda
8. Convención de nombres
9. Pseudocódigo CDK de los puntos delicados
10. Qué deliberadamente **NO** hacemos (anti-sobreingeniería)
11. Diagrama del stack (ASCII)
12. Riesgos de infra y preguntas abiertas

---

## 1. Alcance, supuestos y dependencias entre dominios

### 1.1 Qué define este proyecto CDK

- Front estático: **S3 privado + CloudFront** con OAC.
- Back: **5 Lambdas** (`api`, `auth-steam`, `agent`, `wol`, `reaper`) arm64, con **Function URLs**
  donde aplica (nunca API Gateway).
- Datos: **DynamoDB single-table**, PROVISIONED 25/25, sin GSI.
- Certificado **ACM en us-east-1** (obligatorio para CloudFront), consumido por el stack de app en
  **us-east-2** vía `crossRegionReferences`.
- **ResponseHeadersPolicy** (CSP/HSTS/…) en las rutas de la SPA.
- **EventBridge Scheduler** (un tick recurrente → `reaper`).
- **SSM Parameter Store SecureString** para los 3 secretos (NO Secrets Manager).
- **Route53** (zona `ventrax.dev` ya existente): alias del sitio a CloudFront. `home.ventrax.dev`
  (DDNS) lo gestiona el agente en runtime, **no** CDK (ver §6.9).
- **CloudWatch Logs** con retención corta y **AWS Budgets** de $1.

### 1.2 Fuera de alcance de este documento

Costos desglosados · runbook de despliegue/bootstrap · código de aplicación de las Lambdas (solo su
contrato de infra: memoria, timeout, env, permisos) · componente local (Ansible/agente/SourceBans++,
doc del dominio "local") · esquema fino de claves DynamoDB (doc "modelo de datos"; aquí solo se
provisiona la tabla y se fija la restricción **sin GSI**).

### 1.3 Supuestos sobre otros dominios (declarados)

| # | Supuesto | Dominio dueño |
|---|---|---|
| S1 | El **token del JWT de sesión viaja en cookie HttpOnly** (`l4d2p_session`, `Secure`, `SameSite=Lax`), **NO** en header `Authorization`. Es un **requisito duro** impuesto por la infra: CloudFront con OAC hacia Function URLs **reserva el header `Authorization`** para su firma SigV4 (ver §6.4). La SPA **no debe** enviar `Authorization`. | auth / front |
| S2 | La SPA orquesta el *wake-on-uso* de `/sourcebans`: consulta estado del host vía `/api`, dispara WoL si el usuario es operador, muestra "despertando…", y **solo entonces** navega a `/sourcebans/`. La infra deja además un *backstop* de error 502/504→SPA. | front / operador |
| S3 | En la PC de casa, nginx sirve el panel SourceBans++ **bajo el prefijo `/sourcebans/`** y honra `Host: l4d2.ventrax.dev` (base-URL del panel = `https://l4d2.ventrax.dev/sourcebans`). CloudFront no reescribe el path. | local (Ansible) |
| S4 | `home.ventrax.dev` presenta un **certificado TLS públicamente confiable** (Let's Encrypt, reto DNS-01 vía Route53) en el puerto de origen, para que CloudFront acepte la conexión HTTPS al origen. | local (Ansible) |
| S5 | El **agente** en la PC hace polling saliente HTTPS a la Function URL de `agent` con un **token bearer** (secreto compartido en SSM). Reporta su IP pública en cada heartbeat; el Lambda `agent` actualiza `home.ventrax.dev` en Route53. La PC **no** tiene credenciales AWS. | local (Ansible) / infra |
| S6 | El router de casa **reenvía el puerto UDP 9** (WoL) a la NIC/broadcast; WoL ya verificado desde internet (MAC `0A:E0:AF:AF:28:22`). El Lambda `wol` envía el *magic packet* a la IP pública (leída del item `Host` en DynamoDB, DDNS como respaldo). | local |
| S7 | El SPA se compila fuera de este proyecto (Vite/otro) y sus artefactos se suben al bucket (por `BucketDeployment` o por el pipeline de deploy). La infra solo garantiza el bucket + invalidación. | front / deploy |
| S8 | La **lógica de auto-apagado por "sostenes"** (spec §7) corre en el **agente local**, no en la nube. La nube solo expira intents/cola (`reaper`) y ordena `poweroff`/levantar servidor encolando comandos que el agente recoge. | local |

---

## 2. Cuenta, regiones y bootstrap

| Parámetro | Valor |
|---|---|
| Cuenta AWS | `211125402452` (perfil SSO `ventrax_infra_prod`) |
| Región de la app | **us-east-2** (Ohio) — Lambdas, DynamoDB, S3, CloudFront (global, creada aquí), SSM, Scheduler, Budget |
| Región del cert | **us-east-1** (N. Virginia) — **solo** el ACM de CloudFront |
| Zona Route53 | `ventrax.dev` → `Z0798505KCA3V0GU54OJ` (global, no tiene región) |
| Bootstrap | us-east-2 **ya** bootstrapeado. **Falta bootstrapear us-east-1** (requerido por el cert stack). El comando exacto va en el doc de deploy. |

**Nota de bootstrap para `crossRegionReferences`:** ambas regiones deben estar bootstrapeadas
(us-east-1 y us-east-2) con una versión de bootstrap reciente, porque el mecanismo de referencias
cruzadas crea *custom resources* + parámetros SSM en la región productora (us-east-1) y lectores en
la consumidora (us-east-2).

---

## 3. Estructura de carpetas del proyecto CDK (`infra/`)

Ruta raíz en el repo del proyecto: `/home/ventrax/modules/personal/l4d2-panel/infra/`.

```
infra/
├── bin/
│   └── l4d2-panel.ts            # Entry del App CDK. Instancia CertStack (us-east-1) y AppStack (us-east-2).
├── lib/
│   ├── config.ts               # Lee context → objeto tipado `AppConfig`. Fuente única de parámetros.
│   ├── cert-stack.ts           # Stack us-east-1: ACM DNS-validated para l4d2.ventrax.dev. Exporta certificateArn.
│   ├── app-stack.ts            # Stack us-east-2: orquesta todos los constructs de abajo.
│   └── constructs/
│       ├── data.ts             # DynamoDB single-table (PROVISIONED 25/25, TTL, sin GSI).
│       ├── secrets.ts          # Referencias a los 3 SSM SecureString + helper de grants.
│       ├── functions.ts        # Factory `makeFn()` de NodejsFunction (arm64, defaults) + las 5 funciones.
│       ├── static-site.ts      # S3 privado + OAC + (opcional) BucketDeployment de la SPA.
│       ├── response-headers.ts # ResponseHeadersPolicy (CSP, HSTS, nosniff, referrer, frame, permissions).
│       ├── cdn.ts              # CloudFront: orígenes (S3-OAC, 2× FURL-OAC, custom home), 3 behaviors, error responses.
│       ├── scheduling.ts       # EventBridge Scheduler: ScheduleGroup + tick(1 min) → reaper + rol de invocación.
│       ├── dns.ts              # Route53: A/AAAA alias l4d2.ventrax.dev → CloudFront.
│       └── budget.ts           # AWS Budgets: mensual $1 con alertas por email.
├── lambdas/                    # Código de las funciones (bundled por NodejsFunction / esbuild).
│   ├── api/index.ts            # Handler HTTP: estado flota, reservar, cola, cerrar, config, /api/agent-side no.
│   ├── auth-steam/index.ts     # Steam OpenID 2.0: inicio + validación de retorno + emisión de JWT (cookie).
│   ├── agent/index.ts          # Endpoint que consume el agente local (heartbeat, fetch de comandos, DDNS).
│   ├── wol/index.ts            # Arma y envía el magic packet UDP.
│   ├── reaper/index.ts         # Barrido periódico: expira intents, promueve cola, reintenta WoL.
│   └── shared/                 # Utilidades comunes (cliente Dynamo, cache de SSM, verificación de JWT, respuestas).
│       ├── ddb.ts
│       ├── ssm.ts
│       ├── jwt.ts
│       └── http.ts
├── cdk.json                    # `app: npx ts-node bin/l4d2-panel.ts` + bloque `context` (ver §4).
├── package.json                # deps: aws-cdk-lib, constructs, esbuild, aws-sdk v3 (para las lambdas).
├── tsconfig.json
├── .gitignore                  # cdk.out/, node_modules/, *.js compilado
└── README.md                   # (entregable en repo) cómo build/deploy — apunta al doc de deploy
```

**Criterio de división en constructs:** cada archivo bajo `constructs/` es un `Construct` reutilizable
que recibe lo que necesita por props (p. ej. `data.ts` no conoce a las Lambdas; `functions.ts` recibe
la `table` y las refs de secretos y aplica los grants). `app-stack.ts` es el único punto que los
cablea. Esto mantiene el stack legible y permite testear/mover piezas sin tocar todo.

> Ambición ajustada: **no** hay múltiples *environments* (dev/qas/prod) ni un `pipelines.CodePipeline`.
> Es un único entorno personal. `config.ts` soporta *overrides* por context por si algún día hace
> falta un `staging`, pero v1 despliega un solo entorno.

---

## 4. Parametrización por *context* (`cdk.json` + `config.ts`)

Todo lo variable vive en `cdk.json > context > "l4d2-panel"` y se lee **una vez** en `config.ts`.
**Nada hardcodeado** en los constructs (especialmente `N`, que es dinámico por ADR D6).

```jsonc
// cdk.json (extracto)
{
  "app": "npx ts-node --prefer-ts-exts bin/l4d2-panel.ts",
  "context": {
    "l4d2-panel": {
      "account":        "211125402452",
      "regionApp":      "us-east-2",
      "regionCert":     "us-east-1",
      "domainName":     "l4d2.ventrax.dev",
      "homeHostname":   "home.ventrax.dev",
      "hostedZoneId":   "Z0798505KCA3V0GU54OJ",
      "hostedZoneName": "ventrax.dev",
      "wolMac":         "0A:E0:AF:AF:28:22",
      "wolUdpPort":     9,
      "serversDefault": 4,          // N inicial; el valor VIVO vive en DynamoDB (item Config), no aquí
      "agentPollSeconds": 15,       // referencia para reserved-concurrency y expectativas de heartbeat
      "logRetentionDays": 7,
      "budgetUsd":      1,
      "budgetEmail":    "alonsolgm001@gmail.com",
      "priceClass":     "PriceClass_100",
      "ssmPrefix":      "/l4d2-panel"
    }
  }
}
```

`config.ts` expone un tipo `AppConfig` con esos campos + los **nombres de los 3 parámetros SSM**
derivados de `ssmPrefix`:

```
${ssmPrefix}/steam-web-api-key
${ssmPrefix}/jwt-signing-secret
${ssmPrefix}/agent-token
```

> **Importante — `serversDefault` NO es la fuente de verdad de N.** N vivo (ADR D6, configurable por
> el operador) vive en el item `Config` de DynamoDB. `serversDefault` solo siembra ese item la primera
> vez y sirve de *fallback*. Ninguna Lambda lee `serversDefault` en caliente para tomar decisiones de
> capacidad.

---

## 5. Stacks y `crossRegionReferences`

Dos stacks, un solo `App`:

| Stack (id CDK) | Región | Contenido | Exporta |
|---|---|---|---|
| **`L4d2PanelCert`** | us-east-1 | ACM `Certificate` DNS-validated para `l4d2.ventrax.dev` (valida vía la zona Route53). | `certificate` (ARN) |
| **`L4d2PanelApp`** | us-east-2 | S3, CloudFront, 5 Lambdas + Function URLs, DynamoDB, SSM refs, Scheduler, Route53 records, Logs, Budget. | — |

`bin/l4d2-panel.ts`:

```ts
const app = new cdk.App();
const cfg = loadConfig(app);            // lee context "l4d2-panel"
const env1 = { account: cfg.account, region: cfg.regionCert }; // us-east-1
const env2 = { account: cfg.account, region: cfg.regionApp };  // us-east-2

const certStack = new CertStack(app, 'L4d2PanelCert', {
  env: env1,
  crossRegionReferences: true,          // productor
  cfg,
});

new AppStack(app, 'L4d2PanelApp', {
  env: env2,
  crossRegionReferences: true,          // consumidor
  cfg,
  certificate: certStack.certificate,   // referencia cruzada us-east-1 → us-east-2
});
```

`crossRegionReferences: true` en **ambos** stacks permite que `AppStack` (us-east-2) use el ARN del
cert creado en us-east-1 sin exportar/importar a mano. CDK inyecta *custom resources* que publican el
valor en SSM (us-east-1) y lo leen (us-east-2). Es la vía soportada y suficiente aquí.

> Alternativa descartada: `DnsValidatedCertificate` (deprecado) o crear el cert "a mano" en us-east-1
> y pasar el ARN por context. `crossRegionReferences` es más limpio y automatiza la validación DNS.

---

## 6. Inventario de recursos (propiedades clave)

### 6.1 ACM Certificate (us-east-1) — `cert-stack.ts`

| Propiedad | Valor |
|---|---|
| Construct | `acm.Certificate` |
| `domainName` | `l4d2.ventrax.dev` |
| `subjectAlternativeNames` | ninguno (no hace falta wildcard; `home.ventrax.dev` usa su propio cert LE del lado de casa) |
| Validación | `CertificateValidation.fromDns(hostedZone)` — inserta el CNAME de validación automáticamente en la zona `ventrax.dev` |
| Región | us-east-1 (obligatorio para CloudFront) |

La zona se resuelve con `HostedZone.fromHostedZoneAttributes({ hostedZoneId, zoneName })`.

### 6.2 S3 (sitio estático) — `static-site.ts`

| Propiedad | Valor |
|---|---|
| Construct | `s3.Bucket` |
| `bucketName` | `l4d2-panel-web-211125402452` (determinista, evita colisión global) |
| `blockPublicAccess` | `BLOCK_ALL` (privado; acceso solo por CloudFront/OAC) |
| `encryption` | `S3_MANAGED` (SSE-S3, gratis; **no** KMS CMK) |
| `versioned` | `false` |
| `publicReadAccess` | `false` |
| `removalPolicy` | `DESTROY` + `autoDeleteObjects: true` (los assets son desechables/reconstruibles) |
| Website hosting | **NO** (sin `websiteIndexDocument`). El *fallback* SPA lo hace CloudFront con *custom error responses*, no el website endpoint de S3 (que sería público). |

Publicación de la SPA (opcional en infra, S7): `s3deploy.BucketDeployment` con `sources`, `destinationBucket`,
`distribution` y `distributionPaths: ['/*']` (invalida CloudFront al desplegar). Si el pipeline de
deploy sube los assets aparte, se omite este construct.

### 6.3 CloudFront Distribution — `cdn.ts`

**Distribución** (`cloudfront.Distribution`):

| Propiedad | Valor |
|---|---|
| `domainNames` | `['l4d2.ventrax.dev']` |
| `certificate` | el cert us-east-1 (referencia cruzada) |
| `minimumProtocolVersion` | `TLS_V1_2_2021` |
| `sslSupportMethod` | `SNI` (default) |
| `priceClass` | `PRICE_CLASS_100` (NA+EU; abarata) |
| `httpVersion` | `HTTP2_AND_3` |
| `enableIpv6` | `true` |
| `defaultRootObject` | `index.html` |
| Access logs | **deshabilitados** (evita costo de S3 de logs; hobby) |

**Orígenes:**

| Origen | Tipo | Detalle |
|---|---|---|
| `s3Origin` | `origins.S3BucketOrigin.withOriginAccessControl(webBucket)` | OAC SigV4; el construct crea el `CfnOriginAccessControl` y ajusta la *bucket policy* (`s3:GetObject` al *service principal* `cloudfront.amazonaws.com` con `AWS:SourceArn = <distribution ARN>`). |
| `apiOrigin` | `origins.FunctionUrlOrigin.withOriginAccessControl(apiFnUrl)` | OAC tipo `lambda` (firma SigV4). Requiere `authType: AWS_IAM` en la Function URL. |
| `authOrigin` | `origins.FunctionUrlOrigin.withOriginAccessControl(authFnUrl)` | Igual que `apiOrigin`. |
| `homeOrigin` | `origins.HttpOrigin('home.ventrax.dev', {...})` | Custom origin al DDNS de casa. `protocolPolicy: HTTPS_ONLY`, `httpsPort: 443`, `originSslProtocols: [TLSV1_2]`, `readTimeout: 30s`, `keepaliveTimeout: 5s`, **sin OAC**. |

**Behaviors (3 explícitos + default):**

| Orden | *Path pattern* | Origen | Cache | Origin Request | Métodos | ResponseHeaders | Notas |
|---|---|---|---|---|---|---|---|
| default | `/*` | `s3Origin` | `CACHING_OPTIMIZED` | `CORS_S3Origin`/none | `GET,HEAD,OPTIONS` | **sí** (SPA policy) | SPA; `compress:true`; `viewerProtocolPolicy: REDIRECT_TO_HTTPS` |
| 1 | `/api/*` | `apiOrigin` | `CACHING_DISABLED` | `ALL_VIEWER_EXCEPT_HOST_HEADER` | `ALLOW_ALL` (GET…DELETE) | sí | La SPA no manda `Authorization` (S1) |
| 2 | `/auth/*` | `authOrigin` | `CACHING_DISABLED` | `ALL_VIEWER_EXCEPT_HOST_HEADER` | `ALLOW_ALL` | sí | Login Steam (302 saliente + retorno) |
| 3 | `/sourcebans/*` | `homeOrigin` | `CACHING_DISABLED` | `ALL_VIEWER` (incluye Host) | `ALLOW_ALL` | **no** (deja que el PHP mande sus headers) | Cookies de sesión SourceBans forwarded |

Detalles críticos:

- **`ALL_VIEWER_EXCEPT_HOST_HEADER`** en `/api/*` y `/auth/*`: con OAC hacia Function URLs, el `Host`
  debe ser el del *origin* (`*.lambda-url.us-east-2.on.aws`) para que la firma SigV4 valide → por eso
  se excluye `Host` del viewer. **El header `Authorization` queda reservado por OAC**; la SPA NO debe
  enviarlo (S1: sesión en cookie `l4d2p_session`, que sí se reenvía).
- **`/sourcebans/*` usa `ALL_VIEWER`** (reenvía `Host: l4d2.ventrax.dev`) para que SourceBans++ genere
  URLs con el host público. La conexión TLS al origen usa SNI `home.ventrax.dev` (S4) mientras el
  `Host` header es `l4d2.ventrax.dev` (S3: nginx lo acepta). Sin OAC (origen no-AWS).
- **`compress: true`** en la SPA; en `/sourcebans` opcional.

**Custom error responses (SPA + backstop de origen caído):**

| Código origen | Respuesta | Path | TTL |
|---|---|---|---|
| 403 | 200 | `/index.html` | 0 |
| 404 | 200 | `/index.html` | 0 |
| 502 | 200 | `/index.html` | 0 |
| 503 | 200 | `/index.html` | 0 |
| 504 | 200 | `/index.html` | 0 |

Racional: 403/404 desde S3+OAC → *deep-linking* de la SPA (React Router) cae a `index.html`.
502/503/504 → si `/sourcebans` se pide con la PC apagada (origen inalcanzable), en vez de una página
de error fea CloudFront devuelve la SPA (200), que lee la URL, dispara el *wake* (si operador) y
muestra "despertando…". Es el **backstop** de S2 (el camino feliz es que la SPA nunca navegue a
`/sourcebans` hasta que el host esté arriba). El `ResponsePagePath` se sirve desde el origen del
*default behavior* (S3). `ttl: 0` evita cachear el fallback.

> Limitación aceptada: los *custom error responses* son **por-distribución**, no por-behavior. Un 502
> transitorio del Lambda `api` también devolvería `index.html`; para un hobby es tolerable (la SPA
> reintenta el XHR). No se sobre-ingeniera con Lambda@Edge para discriminar por path.

### 6.4 ResponseHeadersPolicy — `response-headers.ts`

`cloudfront.ResponseHeadersPolicy` adjunta a las behaviors de la SPA/`/api`/`/auth` (**no** a
`/sourcebans`, para no romper el PHP):

| Header | Valor |
|---|---|
| **Content-Security-Policy** | ver abajo (`override: true`) |
| **Strict-Transport-Security** | `max-age=63072000; includeSubDomains` (`preload: false`) |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| X-Frame-Options / frameOptions | `DENY` |
| Permissions-Policy (custom header) | `geolocation=(), microphone=(), camera=(), payment=()` |

CSP (una sola línea, `override: true`):

```
default-src 'none';
base-uri 'self';
frame-ancestors 'none';
form-action 'self' https://steamcommunity.com;
connect-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
font-src 'self';
manifest-src 'self';
img-src 'self' data: https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com https://*.steamstatic.com https://steamcdn-a.akamaihd.net;
```

Racional CSP:
- `connect-src 'self'` — el XHR a `/api` y `/auth` es **mismo origen** (van por CloudFront), así que no
  hace falta abrir dominios externos.
- `img-src` incluye los CDNs de **avatares de Steam** (el perfil que devuelve la Steam Web API).
- `form-action` permite el POST/redirect del botón de login hacia `steamcommunity.com` (Steam OpenID).
- `frame-ancestors 'none'` + `X-Frame-Options DENY` — nadie embebe la SPA.
- HSTS `includeSubDomains` es seguro: aplica a subdominios de `l4d2.ventrax.dev` (no existen) y **no**
  afecta a hermanos como `infogestion.ventrax.dev`. `preload: false` a propósito (subdominio hobby).

### 6.5 Lambdas — `functions.ts`

Todas: `NodejsFunction` (bundling esbuild), `architecture: ARM_64` (Graviton), `runtime: NODEJS_22_X`,
`logGroup` explícito (retención corta, §6.10), `tracing: DISABLED` (X-Ray cuesta; hobby),
`environment` con `TABLE_NAME`, `SSM_PREFIX`, `NODE_OPTIONS=--enable-source-maps`. Sin VPC.

| Función | Física | Mem | Timeout | Reserved conc. | Function URL | Invocada por | Rol / permisos clave |
|---|---|---|---|---|---|---|---|
| **api** | `l4d2p-api` | 256 MB | 10 s | 5 | **Sí** (`AWS_IAM`, OAC) | CloudFront `/api/*` | DDB RW tabla; `lambda:InvokeFunction` sobre `wol`; leer SSM `jwt-signing-secret` |
| **auth-steam** | `l4d2p-auth-steam` | 256 MB | 10 s | 2 | **Sí** (`AWS_IAM`, OAC) | CloudFront `/auth/*` | DDB RW (upsert usuario); leer SSM `steam-web-api-key` + `jwt-signing-secret` |
| **agent** | `l4d2p-agent` | 256 MB | 10 s | 2 | **Sí** (`NONE` + token) | Agente local (directo) | DDB RW; leer SSM `agent-token`; `route53:ChangeResourceRecordSets` (zona) para DDNS |
| **wol** | `l4d2p-wol` | 128 MB | 10 s | 1 | **No** | `api` (async) + `reaper` | DDB read (item `Host` → IP); egress UDP (sin permiso IAM, es red) |
| **reaper** | `l4d2p-reaper` | 256 MB | 30 s | 1 | **No** | EventBridge Scheduler (tick 1 min) | DDB RW; `lambda:InvokeFunction` sobre `wol` |

Racional:
- **arm64** por costo/rendimiento (Graviton, ~20% más barato por ms).
- **Reserved concurrency** actúa como *rate-limit* barato y aísla blast radius. Suma = 11 (≪ 1000 del
  límite de cuenta, deja el piso de 100 no-reservado intacto). No cuesta dinero.
- **`reaper` con reserved=1** garantiza que el barrido **no se solape** (singleton).
- **`wol` con reserved=1** — idempotente, serializar reintentos está bien.
- **`agent` separado del `api`** para que el polling constante del host (cada ~15 s) no compita con la
  concurrencia de usuarios y viceversa.

**Function URLs:**

| Función | `authType` | CORS | Acceso |
|---|---|---|---|
| `api`, `auth-steam` | `AWS_IAM` | no aplica (mismo origen vía CloudFront) | **solo CloudFront** (OAC firma; se añade `lambda:InvokeFunctionUrl` al *service principal* `cloudfront.amazonaws.com` con `SourceArn = <distribution ARN>`) |
| `agent` | `NONE` | `allowedOrigins: []` (no navegador) | **directo** desde la PC; el handler valida `Authorization: Bearer <agent-token>` con comparación en tiempo constante contra el SSM `agent-token` |

> **Por qué `agent` es `authType NONE` y no `AWS_IAM`:** la PC de casa no tiene credenciales AWS
> (S5) y no queremos firmar SigV4 desde el agente. La Function URL es un dominio aleatorio
> `*.lambda-url.us-east-2.on.aws`; el control real es el **token secreto** (SSM) + superficie mínima
> (solo "reporta estado / dame comandos de ESTE host"). Para un hobby es suficiente; si se quisiera
> endurecer, se puede añadir verificación del IP público de casa dentro del handler. Este es el único
> endpoint AWS con `authType NONE`, y **no** pasa por CloudFront (tráfico máquina-a-máquina).

### 6.6 DynamoDB — `data.ts`

| Propiedad | Valor |
|---|---|
| Construct | `dynamodb.Table` (clásico; **no** `TableV2`, no hay global tables) |
| `tableName` | `l4d2-panel` |
| `partitionKey` | `pk` (STRING) |
| `sortKey` | `sk` (STRING) |
| `billingMode` | `PROVISIONED` |
| `readCapacity` | `25` |
| `writeCapacity` | `25` |
| **GSI** | **ninguno** (v1). Ver nota. |
| `timeToLiveAttribute` | `ttl` (epoch s) — expira intents/entradas de cola/comandos viejos; borrado gratis |
| `pointInTimeRecovery` | `true` (seguro; costo ~$0 con <pocos MB) |
| `encryption` | default (AWS-owned key, gratis) |
| `stream` | ninguno (sin consumidores) |
| `removalPolicy` | `RETAIN` |
| `deletionProtection` | `true` |

**Por qué sin GSI:** el *free tier* de DynamoDB (25 RCU + 25 WCU **agregados por cuenta/región**) se
consume **entero** con la tabla en 25/25. Cualquier GSI con capacidad provisionada **suma** y rompería
el free tier. Dado el volumen ínfimo (N≤~8 slots, decenas de usuarios), **todos los patrones de acceso
se resuelven con *Query* dentro de partición o *Scan* de tablas de pocos ítems** (un Scan de la
partición de flota son ≤N ítems, coste despreciable). El diseño de claves fino es del doc "modelo de
datos"; desde infra la **restricción es dura: 0 GSI en v1**. Si ese dominio demostrara necesitar uno,
la infra deberá **repartir** la capacidad (p. ej. tabla 20/20 + GSI 5/5) para mantener el agregado
≤ 25/25 — se documenta como *cambio coordinado*, no se agrega a la ligera.

Bosquejo de layout (informativo, propiedad del doto "modelo de datos"; aquí solo para justificar el
"sin GSI"):

```
USER#<steamid64>      | PROFILE            -> nick, avatar, operador(bool), suspendido(bool), creado
USER#<steamid64>      | INTENT             -> estado(máquina), etapa, slot, creado, ttl
CONFIG                | CONFIG             -> nActual, reservasHabilitadas(bool)
FLEET                 | SERVER#<k>         -> estado, dueño(steamid), inicio, mapa, jugadores  (Query FLEET => todos los slots)
QUEUE                 | <epoch>#<steamid>  -> ttl  (Query QUEUE => FIFO por sk)
HOST                  | HOST               -> estadoPc, ultimoHeartbeat, ipPublica
HOST                  | CMD#<uuid>         -> tipo(levantar|cerrar|poweroff), args, ttl  (Query HOST begins_with CMD#)
```

Ningún patrón requiere índice invertido: "servidor que posee el usuario" se guarda como atributo en
`USER#..|PROFILE` o se resuelve escaneando los ≤N ítems de `FLEET`.

### 6.7 Secretos — SSM Parameter Store (`secrets.ts`)

**Decisión (ADR/tarea): SSM Parameter Store `SecureString`, NO Secrets Manager** (Secrets Manager
cobra ~$0.40/secreto/mes; SSM Standard `SecureString` con la KMS *managed key* `alias/aws/ssm` es
gratis).

| Nombre | Contenido | Consumidores |
|---|---|---|
| `/l4d2-panel/steam-web-api-key` | Steam Web API key (perfil/validación) | `auth-steam` |
| `/l4d2-panel/jwt-signing-secret` | secreto HS256 (256-bit) para firmar/verificar el JWT de sesión | `api`, `auth-steam` |
| `/l4d2-panel/agent-token` | token bearer del agente local | `agent` |

**Provisión:** CloudFormation **no** puede crear `SecureString` con valor en plantilla → los 3 se
crean **fuera de banda** una vez (`aws ssm put-parameter --type SecureString …`, detalle en el doc de
deploy). CDK **solo referencia y otorga lectura**:

```ts
const jwtSecret = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'JwtSecret', {
  parameterName: `${cfg.ssmPrefix}/jwt-signing-secret`,
});
jwtSecret.grantRead(apiFn);   // ssm:GetParameter sobre el ARN del parámetro
```

- Las Lambdas leen con `GetParameter WithDecryption=true` **en cold start** y **cachean** en *module
  scope* (evita throttle y latencia). Alternativa opcional: la *AWS Parameters and Secrets Lambda
  Extension* (capa) — se omite en v1 por simplicidad; el SDK v3 basta.
- Permiso: `grantRead` añade `ssm:GetParameter`. Para `SecureString` con `alias/aws/ssm` (managed) no
  hace falta política KMS explícita en el rol (el descifrado lo media el servicio SSM sobre la managed
  key). **No** se usa CMK propia (costaría $1/mes por key).

### 6.8 EventBridge Scheduler — `scheduling.ts`

| Recurso | Valor |
|---|---|
| `scheduler.ScheduleGroup` | `l4d2-panel` |
| `scheduler.Schedule` | `l4d2p-tick` — `ScheduleExpression.rate(Duration.minutes(1))`, `flexibleTimeWindow: OFF` |
| Target | `targets.LambdaInvoke(reaperFn)` |
| Rol de invocación | rol dedicado con `lambda:InvokeFunction` **solo** sobre `reaperFn` (lo crea el target L2) |

Un **único tick recurrente (1 min) → `reaper`** cubre: expirar intents vencidos (TTL lógico),
promover la cola cuando se libera un slot, limpiar entradas muertas, y **reintentar WoL** (invoca
`wol`) para intents en estado `DESPERTANDO` sin heartbeat. El **primer** paquete WoL lo dispara el
Lambda `api` (invocación async a `wol`) al reservar con la PC apagada; los reintentos, cada minuto,
los hace `reaper`. Granularidad de 1 min es suficiente (boot ~3 min; la NIC tarda 15-30 s en modo WoL).

> **Deliberadamente NO** se crean *schedules* de una sola vez por-intent (que exigirían
> `scheduler:CreateSchedule/DeleteSchedule` + `iam:PassRole` en el Lambda `api`). Es complejidad que no
> aporta a este volumen. Un solo tick estático, gestionado por CDK, es más simple y robusto. (Posible
> optimización v2 si el "always-on tick" molestara, pero ~43k invocaciones/mes de `reaper` caen
> holgadamente en el free tier de Lambda.)

### 6.9 Route53 (DNS) — `dns.ts`

Zona existente `ventrax.dev` (`Z0798505KCA3V0GU54OJ`), resuelta con `fromHostedZoneAttributes`.

| Record | Tipo | Target | Gestión |
|---|---|---|---|
| `l4d2.ventrax.dev` | A (alias) | `RecordTarget.fromAlias(new CloudFrontTarget(distribution))` | **CDK** |
| `l4d2.ventrax.dev` | AAAA (alias) | idem (IPv6) | **CDK** |
| `home.ventrax.dev` | A | IP pública de casa (dinámica) | **Agente/Lambda `agent`** en runtime — **NO CDK** |

**`home.ventrax.dev` NO lo maneja CDK a propósito:** su valor cambia con la IP de casa. Si CDK lo
creara, cada `cdk deploy` lo revertiría a un placeholder (drift). En su lugar, el Lambda `agent` hace
`ChangeResourceRecordSets` (UPSERT) sobre ese record cuando el heartbeat reporta una IP nueva (S5). El
rol de `agent` lleva `route53:ChangeResourceRecordSets` sobre el ARN de la zona
(`arn:aws:route53:::hostedzone/Z0798505KCA3V0GU54OJ`) — Route53 IAM no permite acotar a un solo
record, solo a la zona; aceptable. TTL bajo (60 s) en el UPSERT para que CloudFront reevalúe pronto el
origen.

> El CNAME de validación del ACM (§6.1) también lo inserta CDK (vía `CertificateValidation.fromDns`).

### 6.10 CloudWatch Logs

- Un `logs.LogGroup` **explícito por Lambda**: `/aws/lambda/l4d2p-<nombre>`, `retention: ONE_WEEK`
  (7 días), `removalPolicy: DESTROY`. Se pasa a cada `NodejsFunction` vía `logGroup:` para **evitar**
  que Lambda cree el grupo con retención infinita (que acumularía costo).
- Sin *metric filters* ni dashboards en v1 (el monitoreo real es la pila Prometheus/Grafana local del
  repo `l4d2-fleet`). Hobby: los logs de CloudWatch son solo para depurar las Lambdas.

### 6.11 AWS Budgets — `budget.ts`

| Propiedad | Valor |
|---|---|
| Construct | `budgets.CfnBudget` (L1; no hay L2) |
| `budgetType` | `COST` |
| `timeUnit` | `MONTHLY` |
| `budgetLimit` | `{ amount: 1, unit: 'USD' }` |
| Alertas | 80% **ACTUAL** y 100% **FORECASTED** → `SNS`/email `alonsolgm001@gmail.com` (subscriber `EMAIL`) |

Los 2 primeros budgets de la cuenta son gratis. Es la red de seguridad ante un runaway (bucle de WoL,
invocaciones desbocadas). El desglose de costo esperado va en el doc de costos.

---

## 7. IAM: roles y permisos mínimos por Lambda

Cada Lambda tiene **su propio rol** (no compartido), con la `AWSLambdaBasicExecutionRole` gestionada
(solo logs a SU log group) + permisos mínimos explícitos:

```
api        : ddb:GetItem,PutItem,UpdateItem,Query,DeleteItem  sobre <table.arn>
             lambda:InvokeFunction                             sobre <wol.arn>
             ssm:GetParameter                                  sobre <jwt-signing-secret>

auth-steam : ddb:GetItem,PutItem,UpdateItem                    sobre <table.arn>
             ssm:GetParameter                                  sobre <steam-web-api-key>, <jwt-signing-secret>

agent      : ddb:GetItem,PutItem,UpdateItem,Query,DeleteItem   sobre <table.arn>
             ssm:GetParameter                                  sobre <agent-token>
             route53:ChangeResourceRecordSets                  sobre <hostedzone/Z0798505KCA3V0GU54OJ>
             (opcional) route53:GetChange                      sobre *

wol        : ddb:GetItem                                       sobre <table.arn>   (leer Host.ipPublica)
             (egress UDP: es red, no requiere IAM)

reaper     : ddb:GetItem,PutItem,UpdateItem,Query,DeleteItem   sobre <table.arn>
             lambda:InvokeFunction                             sobre <wol.arn>
```

Se usan los `grant*` de los constructs (`table.grantReadWriteData(fn)`, `wolFn.grantInvoke(apiFn)`,
`param.grantRead(fn)`) para no escribir políticas a mano. Los grants de DynamoDB se acotan al ARN de
la tabla (sin GSI, no hay ARN de índice que otorgar). El único permiso "amplio" es el de Route53
(acotado a la zona, no al record, por límite del servicio).

**Permiso de CloudFront sobre las Function URLs (OAC):** además del rol de ejecución, cada Function
URL con `AWS_IAM` recibe una *resource policy* (`lambda:InvokeFunctionUrl`) para el *principal*
`cloudfront.amazonaws.com` condicionada a `AWS:SourceArn = <distribution ARN>`. El helper
`FunctionUrlOrigin.withOriginAccessControl` la cablea; si la versión de `aws-cdk-lib` fuese anterior a
ese helper, se añade a mano con `fn.addPermission('CfInvoke', { principal: new ServicePrincipal(
'cloudfront.amazonaws.com'), action: 'lambda:InvokeFunctionUrl', sourceArn: distribution.arn })` + un
`CfnOriginAccessControl` de `originAccessControlOriginType: 'lambda'`.

---

## 8. Convención de nombres

| Recurso | Patrón | Ejemplo |
|---|---|---|
| Stacks | `L4d2Panel<Rol>` | `L4d2PanelCert`, `L4d2PanelApp` |
| Lambdas | `l4d2p-<fn>` | `l4d2p-api`, `l4d2p-wol` |
| Log groups | `/aws/lambda/l4d2p-<fn>` | `/aws/lambda/l4d2p-reaper` |
| Tabla DynamoDB | `l4d2-panel` | — |
| Bucket S3 | `l4d2-panel-web-<account>` | `l4d2-panel-web-211125402452` |
| SSM params | `/l4d2-panel/<clave>` | `/l4d2-panel/agent-token` |
| ScheduleGroup | `l4d2-panel` | — |
| Schedule | `l4d2p-<nombre>` | `l4d2p-tick` |
| Distribution comment | `l4d2-panel` | — |
| ResponseHeadersPolicy | `l4d2p-security-headers` | — |
| Tags (todos los recursos) | `Project=l4d2-panel`, `Env=prod`, `ManagedBy=cdk` | aplicado a nivel App con `Tags.of(app).add(...)` |

Prefijo `l4d2p-` (compacto) para recursos con límite de longitud; `l4d2-panel` (legible) donde no hay
presión de caracteres. Todo *tag*eado con `Project=l4d2-panel` para filtrar en la factura.

---

## 9. Pseudocódigo CDK de los puntos delicados

### 9.1 Cert stack (us-east-1)

```ts
export class CertStack extends Stack {
  public readonly certificate: acm.ICertificate;
  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.cfg.hostedZoneId, zoneName: props.cfg.hostedZoneName,
    });
    this.certificate = new acm.Certificate(this, 'Cert', {
      domainName: props.cfg.domainName,                       // l4d2.ventrax.dev
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
```

### 9.2 S3 + OAC + Function URL OAC + CloudFront (extracto de `cdn.ts`)

```ts
// S3 privado con OAC
const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);

// Function URLs AWS_IAM
const apiFnUrl  = apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
const authFnUrl = authFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
const apiOrigin  = origins.FunctionUrlOrigin.withOriginAccessControl(apiFnUrl);
const authOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(authFnUrl);

// Origen custom = PC de casa (DDNS)
const homeOrigin = new origins.HttpOrigin(cfg.homeHostname, {
  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
  originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
  readTimeout: Duration.seconds(30),
  keepaliveTimeout: Duration.seconds(5),
});

const lambdaBehavior = (origin: cloudfront.IOrigin) => ({
  origin,
  viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
  cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
  originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
  responseHeadersPolicy: securityHeaders,
});

const dist = new cloudfront.Distribution(this, 'Dist', {
  domainNames: [cfg.domainName],
  certificate: props.certificate,          // us-east-1, referencia cruzada
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
  httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
  enableIpv6: true,
  defaultRootObject: 'index.html',
  defaultBehavior: {
    origin: s3Origin,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    responseHeadersPolicy: securityHeaders,
    compress: true,
  },
  additionalBehaviors: {
    '/api/*':  lambdaBehavior(apiOrigin),
    '/auth/*': lambdaBehavior(authOrigin),
    '/sourcebans/*': {
      origin: homeOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,  // incluye Host
      // sin responseHeadersPolicy: el PHP manda los suyos
    },
  },
  errorResponses: [403, 404, 502, 503, 504].map(code => ({
    httpStatus: code, responseHttpStatus: 200,
    responsePagePath: '/index.html', ttl: Duration.seconds(0),
  })),
});
```

### 9.3 Factory de Lambdas (`functions.ts`)

```ts
function makeFn(scope: Construct, id: string, name: string, entry: string, cfg: AppConfig,
                over: Partial<nodejs.NodejsFunctionProps> = {}) {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    logGroupName: `/aws/lambda/${name}`,
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  return new nodejs.NodejsFunction(scope, id, {
    functionName: name,
    entry,                                    // lambdas/<fn>/index.ts
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256, timeout: Duration.seconds(10),
    logGroup,
    environment: { TABLE_NAME: table.tableName, SSM_PREFIX: cfg.ssmPrefix,
                   NODE_OPTIONS: '--enable-source-maps' },
    bundling: { minify: true, sourceMap: true, format: nodejs.OutputFormat.ESM },
    ...over,
  });
}
// wol: memorySize 128; reaper: timeout 30; reservedConcurrentExecutions por función (5/2/2/1/1)
```

### 9.4 Scheduler tick

```ts
const group = new scheduler.ScheduleGroup(this, 'Group', { scheduleGroupName: 'l4d2-panel' });
new scheduler.Schedule(this, 'Tick', {
  scheduleGroup: group, scheduleName: 'l4d2p-tick',
  schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
  target: new schedulerTargets.LambdaInvoke(reaperFn, {}),
});
```

### 9.5 DNS del sitio

```ts
const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
  hostedZoneId: cfg.hostedZoneId, zoneName: cfg.hostedZoneName });
const target = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(dist));
new route53.ARecord   (this, 'AliasA',    { zone, recordName: 'l4d2', target });
new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName: 'l4d2', target });
// home.ventrax.dev NO se crea aquí (lo gestiona el Lambda agent en runtime).
```

---

## 10. Qué deliberadamente **NO** hacemos (anti-sobreingeniería)

| Descartado | Por qué |
|---|---|
| **API Gateway** | Function URLs + CloudFront/OAC cubren todo; API GW cobra por request y añade complejidad. |
| **Cognito** | ADR D4: login propio con Steam OpenID + JWT. |
| **VPC / NAT Gateway** | Nada necesita red privada; NAT costaría ~$32/mes (mataría el "~$0"). Las Lambdas van sin VPC (egress directo, UDP incluido). |
| **Secrets Manager** | SSM SecureString es gratis; SM cobra por secreto. |
| **GSI en DynamoDB** | Rompería el free tier 25/25; el volumen no lo justifica (Query/Scan bastan). |
| **KMS CMK propia** | AWS-managed keys (SSM/DynamoDB/S3) son gratis; una CMK cuesta $1/mes. |
| **X-Ray / dashboards / metric filters** | Monitoreo real es Prometheus/Grafana local; CloudWatch solo para debug. |
| **Schedules one-shot por-intent** | Un tick estático de 1 min basta; evita permisos `CreateSchedule`/`PassRole`. |
| **Lambda@Edge / CloudFront Functions** | El *fallback* SPA se resuelve con custom error responses; no hay lógica de edge que justifique el costo/complejidad. La orquestación del wake vive en la SPA + `/api`. |
| **Multi-environment / CodePipeline** | Un único entorno personal; `cdk deploy` a mano (o un workflow simple) es suficiente. |
| **CloudFront access logs / WAF** | Costo de S3/WAF sin beneficio a este volumen; la superficie ya es mínima. |
| **`autoDeleteObjects` en el bucket… salvo web** | Solo el bucket web (desechable) usa DESTROY; DynamoDB va RETAIN + deletion protection. |

---

## 11. Diagrama del stack (ASCII)

```
                                    Route53  ventrax.dev (Z0798505KCA3V0GU54OJ)
                                    ├── l4d2.ventrax.dev  A/AAAA alias ─► CloudFront   [CDK]
                                    └── home.ventrax.dev  A (DDNS)      ─► IP casa      [agente, runtime]
                                                   │
      ┌────────────────────────────────────────── │ ──────────────────────────────────────────┐
      │  L4d2PanelCert (us-east-1)                 │                                            │
      │   ACM Certificate  l4d2.ventrax.dev  ──────┼──(crossRegionReferences)──┐                │
      └────────────────────────────────────────── │ ───────────────────────── │ ──────────────┘
                                                   ▼                           ▼
      ┌──────────────────────────────────── L4d2PanelApp (us-east-2) ──────────────────────────┐
      │                                                                                          │
      │   CloudFront Distribution  (cert us-east-1, PriceClass_100, HTTP2/3)                     │
      │   + ResponseHeadersPolicy (CSP/HSTS)   + errorResponses 403/404/502/503/504 → index.html │
      │      │                                                                                    │
      │      ├── /*            ─(OAC SigV4)─►  S3  l4d2-panel-web-2111…  (privado, BLOCK_ALL)     │
      │      ├── /api/*        ─(OAC IAM)──►  FURL  l4d2p-api      256MB/10s/rc5  ─┐               │
      │      ├── /auth/*       ─(OAC IAM)──►  FURL  l4d2p-auth-steam 256MB/10s/rc2 │               │
      │      └── /sourcebans/* ─(HttpOrigin)► home.ventrax.dev:443 (TLS LE)  ...   │               │
      │                                                                            ▼               │
      │                                                      DynamoDB  l4d2-panel  PK/SK           │
      │   l4d2p-agent  FURL(NONE+token) ◄── agente PC (polling)  ──►  PROVISIONED 25/25, TTL, PITR │
      │       └─ route53:ChangeRRSets (home.ventrax.dev)             (sin GSI)                     │
      │   l4d2p-wol   (no FURL) ◄── api(async) / reaper ──► UDP:9 ─► IP casa (magic packet)        │
      │   l4d2p-reaper(no FURL) ◄── EventBridge Scheduler  l4d2p-tick  rate(1 min)                 │
      │                                                                                            │
      │   SSM SecureString:  /l4d2-panel/{steam-web-api-key, jwt-signing-secret, agent-token}      │
      │   CloudWatch Logs:   /aws/lambda/l4d2p-*  (retención 7 días)                               │
      │   AWS Budgets:       mensual $1  →  email alonsolgm001@gmail.com                           │
      └──────────────────────────────────────────────────────────────────────────────────────────┘

      Fuera de AWS (repo l4d2-fleet, Ansible):  flota l4d2@1..N (UDP 6033+), MySQL+SourceBans++,
      nginx /sourcebans/ (cert LE), agente (heartbeat + comandos + DDNS), WoL target (NIC 0A:E0:AF:AF:28:22).
```

---

## 12. Riesgos de infra y preguntas abiertas

### Riesgos

| Riesgo | Mitigación |
|---|---|
| **Header `Authorization` reservado por OAC** en `/api`/`/auth` → si la SPA lo usa, CloudFront lo pisa y el login "no funciona" de forma confusa. | S1 es requisito duro: sesión en cookie `l4d2p_session`. Documentado en el contrato con el dominio auth/front; verificar en QA que ningún fetch mande `Authorization`. |
| **CloudFront exige cert de origen públicamente confiable** para `/sourcebans` HTTPS. Si casa sirve HTTP o cert self-signed, CloudFront devuelve 502. | S4: Let's Encrypt (DNS-01 vía Route53) en `home.ventrax.dev`. Fallback degradado: `HttpOrigin` en HTTP (tráfico CF↔casa sin cifrar) solo si LE fuese inviable — se desaconseja. |
| **Custom error responses son por-distribución**: un 502 del Lambda `api` también devuelve `index.html`. | Tolerado (la SPA reintenta el XHR). Si molesta, mover el mapeo 502/503/504 fuera y manejar el wake 100% desde la SPA antes de navegar. |
| **`home.ventrax.dev` con IP cambiante + PC apagada** → CloudFront cachea NXDOMAIN/errores de origen. | TTL 60 s en el UPSERT del agente; `CACHING_DISABLED` en `/sourcebans`; el wake es SPA-first (no se navega hasta que el host reporta arriba). |
| **`authType NONE` en `agent`** → endpoint público protegido solo por token. | Token de 256-bit en SSM, comparación en tiempo constante, superficie mínima; endurecible con allowlist de IP. Riesgo bajo para hobby. |
| **Runaway de invocaciones / bucle WoL** dispara costo. | Reserved concurrency por función + AWS Budget $1 con alerta forecast; `reaper` singleton (rc=1). |
| **`crossRegionReferences` requiere us-east-1 bootstrapeado**; si no, el deploy del cert falla. | Prerrequisito documentado (§2); bootstrap de us-east-1 antes del primer deploy. |
| **Drift si alguien crea `home.ventrax.dev` en CDK** por error. | Explícitamente excluido de CDK; el agente es el único dueño de ese record. |

### Preguntas abiertas (para otros dominios / decisiones futuras)

- **Cookie vs. header definitivo para el JWT** (dominio auth): confirmar `HttpOnly`+`Secure`+`SameSite=Lax`
  y nombre `l4d2p_session`. La infra ya asume cookie (S1).
- **Puerto/protocolo real del panel en casa** (dominio local): ¿443 HTTPS con LE, o un puerto forwarded
  distinto? El `HttpOrigin` asume 443/HTTPS.
- **¿El agente actualiza Route53 directamente (vía Lambda `agent`) o corre un DDNS client con IAM user
  en casa?** Este doc asume lo primero (sin credenciales AWS en casa). Confirmar con el dominio local.
- **Runtime de las Lambdas**: se asume Node 22 + TS/esbuild. Si el dominio de backend prefiere Python,
  cambia `runtime`/`bundling` pero no la topología de recursos.
- **¿Publicación de la SPA por `BucketDeployment` (dentro de CDK) o por pipeline aparte?** (dominio
  deploy). La infra soporta ambas; por defecto se deja `BucketDeployment` para simplicidad.
- **N máximo real** (riesgo de capacidad de la PC, spec §16): no afecta la infra AWS (N vive en
  DynamoDB), pero condiciona cuántos puertos UDP 6033+ forwardear en casa.
```
