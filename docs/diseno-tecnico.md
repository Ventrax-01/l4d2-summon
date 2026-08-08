# L4D2 Panel — Diseño técnico consolidado (criterio de integración)

> Documento de **criterio**: une los 8 diseños de dominio (`docs/tecnico/01..08`) en una sola
> arquitectura coherente, resuelve las contradicciones entre ellos, fija las correcciones obligatorias
> de las revisiones adversariales y ordena la implementación. La fuente de requisitos es
> `docs/especificaciones-v1.md`; los detalles finos viven en cada `docs/tecnico/NN-*.md`. Ante
> conflicto entre un doc de dominio y este documento, **manda este documento**.
>
> Estado: diseño aprobado con cambios. Español. Escala hobby (pocos servidores, decenas de usuarios,
> costo ~$0). No se sobre-ingenieriza.

---

## 1. Resumen ejecutivo

L4D2 Panel es una web para **reservar servidores de Left 4 Dead 2 bajo demanda**. El front (SPA) y el
back (Lambdas) viven en AWS serverless con costo ~$0; la carga de juego corre en la **PC de casa de
Ventrax** (`192.168.18.100`), que normalmente está **apagada** y se enciende sola por **Wake-on-LAN**
al reservar, apagándose cuando no queda ningún "sostén". Auth es **solo Steam OpenID 2.0** con JWT
propio (sin Cognito). Datos en **DynamoDB single-table** (`l4d2-panel`, provisioned 25/25, **cero
GSI**). SourceBans++ corre en la PC y se expone bajo `/sourcebans` con wake-on-uso restringido al
operador. Infra como proyecto **AWS CDK (TypeScript)**, dos stacks (cert en us-east-1, resto en
us-east-2).

**Veredicto de costo:** el costo **neto-nuevo** del proyecto es **~$0.00/mes** en el camino feliz
(todo cae en free tiers permanentes de CloudFront, Lambda, DynamoDB provisioned y EventBridge
Scheduler). El único renglón garantizado distinto de cero es el almacenamiento S3 de la SPA
(~$0.0005/mes). Rango realista **$0.00–$0.20/mes**; sube a **$0.50–$2.00/mes** solo si se cae en una
de las dos trampas: **CloudWatch Logs** (ingesta $0.50/GB si se loguea en el hot-path del polling) o
**DynamoDB on-demand** (pierde el free tier de requests). La factura total seguirá leyendo **~$0.87/mes**
por baseline preexistente ajeno (Route53 + snapshots RDS huérfanos que conviene limpiar).

**Los 8 dominios convergen** en una arquitectura implementable, pero con **dos bloqueantes de producto**
que hay que cerrar antes de codear (co-tenencia de la PC con InfoGestion, y naturaleza estática/dinámica
de la IP pública) y un conjunto de **correcciones obligatorias** derivadas de las revisiones
adversariales (rate-limit horneado en la transacción de claim, fail-safe del auto-apagado, backstop del
estado CERRANDO, normalización de Host WAKING, idempotencia de comandos, y el fin del mapeo global de
error-responses de CloudFront).

**Riesgos top:** (1) **fiabilidad del WoL desde internet** con la PC apagada e IP potencialmente
cambiante; (2) **capacidad real de la PC** (cuántas instancias L4D2 aguanta → fija N) agravada por la
**co-tenencia** con servicios 24/7; (3) **abuso de encendido** (registro abierto + WoL-al-reservar =
power-cycling abusable) que exige rate-limit atómico como defensa dura.

---

## 2. Arquitectura general

**Plano de control en la nube, plano de datos en casa, reconciliación por estado deseado.** La API
escribe el estado *deseado* en DynamoDB; el **agente** en la PC hace polling **saliente** HTTPS
(~12s), reporta el estado *real* y recoge comandos. Nada entra a la PC salvo el **magic packet WoL**
(UDP) y las requests de **`/sourcebans`** (origen custom de CloudFront hacia el DDNS de casa). La SPA
**nunca** habla con DynamoDB directo (sin Cognito no tiene credenciales AWS): **toda** lectura/escritura
pasa por Lambdas detrás de CloudFront.

```
                         Route53 (l4d2.ventrax.dev, zona Z0798505KCA3V0GU54OJ)
                                        │  TLS ACM (us-east-1)
                        ┌───────────────▼─────────────────────────────────────┐
   Navegador ─────────► │  CloudFront (1 distribución, OAC)                    │
   (jugador/operador)   │   /*            → S3 privado (SPA)  [CF Function:     │
                        │                   rewrite deep-link → /index.html]   │
                        │   /api/*        → Lambda api   (Function URL, AWS_IAM)│
                        │   /auth/steam*  → Lambda auth  (Function URL, AWS_IAM)│
                        │   /sourcebans/* → Origen custom home.l4d2.ventrax.dev │
                        │                   (Origin Group: home → S3 despertando)│
                        └──┬──────────┬───────────────────────────┬────────────┘
                           │ cookie   │ SigV4/OAC                  │ AllViewer, sin caché
                           │ l4d2_    │                            │
                           │ session  ▼                            ▼
                    ┌──────┴───────────────────┐         ┌─────────────────────────────────┐
                    │ Lambdas (arm64, Node22)   │         │  PC de casa (normalmente APAGADA)│
                    │  api  auth  wol  reaper   │         │  - flota L4D2 ZoneMod l4d2@1..N  │
                    │  (+ agent Function URL     │         │  - MariaDB + SourceBans++ (PHP)  │
                    │     NONE + SourceIp home)  │◄────────┤  - nginx /sourcebans (X-Origin-  │
                    └──────┬────────────┬────────┘  poll   │      Verify obligatorio)         │
                           │            │ HTTPS   saliente │  - AGENTE Python (systemd)       │
                           │            └──────────────────┤    · reporta slots/IP/sostenes   │
                           ▼                                │    · ejecuta comandos idempot.   │
                    ┌──────────────────┐   magic packet UDP │    · auto-apagado fail-safe      │
                    │ DynamoDB          │───────────────────►    (WoL 0A:E0:AF:AF:28:22)       │
                    │ l4d2-panel        │  Lambda wol → IP    └─────────────────────────────────┘
                    │ 25/25, 0 GSI      │  pública de casa
                    │ SLOT/USER/QUEUE/   │
                    │ CONFIG/HOST/INTENT │   EventBridge Scheduler ── tick rate(1min) ─► reaper
                    └──────────────────┘   (reaper intents/cola, malla WoL, sweep CERRANDO)
```

**Ciclo WoL / auto-apagado (camino ASLEEP, ~3 min):**

```
reservar ─► api: claim atómico (rate-limit + slot + 1-por-usuario) ─► intent DESPERTANDO
        └─► candado Host DOWN→WAKING (singleton) ─► Lambda wol: magic packets en
            offsets 0,15,30,45,60,90,120s (NIC tarda 15-30s en modo WoL) ─► PC bootea
   PC arriba ─► agente primer /poll (heartbeat) ─► Host WAKING→UP
   nube (re)emite START_SERVER k (deadline extendido 180-300s, cmd_id dedup) ─► agente
   systemctl restart l4d2@k + siembra admin por-puerto + verifica A2S ─► slot ACTIVO
   ─► intent LISTO ─► steam://connect al jugador
   ...
   servidor vacío 15min ─► agente cierra ─► slot CERRANDO→LIBRE ─► promueve cola (si hay)
   sin sostenes (fail-safe, heartbeat fresco, boot-grace 90-120s) ─► poweroff limpio
```

**Sostenes que impiden el poweroff** (evaluados por el agente, fail-safe): (1) servidor con jugadores
o vacío <15min; (2) intent/cola en curso **o** slot CERRANDO sin completar (lo comunica la nube como
`hold_poweroff`); (3) SourceBans usado <10min **o** `sourcebansWakeGrace` vigente; (4) sesión SSH del
operador; (5) **[BLOQUEANTE]** actividad de InfoGestion / servicios 24/7 co-residentes, si la PC no se
dedica.

---

## 3. Decisiones de arquitectura (ADR consolidado)

| # | Decisión | Fuente / nota |
|---|---|---|
| A1 | Reserva **bajo demanda**; sin agendadas. 1 servidor por usuario; cola FIFO si los N ocupados. | spec D1/D7/D8 |
| A2 | Servidores **públicos**; el reservador es **admin in-game** (kick/mapa/match, **sin ban**). | spec D2/D3 |
| A3 | Auth **solo Steam OpenID 2.0** (modo stateless/dumb), **JWT propio HS256** en cookie `l4d2_session` HttpOnly/Secure/SameSite=Lax. Sin Cognito, sin refresh token. | 03-auth |
| A4 | Flag `operador` **siempre leído de DynamoDB** (source of truth); el claim `op` del JWT es solo UI. | 03-auth |
| A5 | Datos en **DynamoDB single-table `l4d2-panel`**, PROVISIONED **25/25**, **CERO GSI**, us-east-2. Todo por clave primaria o punteros denormalizados. | 01-datos, 06-infra |
| A6 | Particiones: `SLOT` (N slots en una partición), `USER#<sid>` (PROFILE+INTENT), `QUEUE` (FIFO con contador atómico), `CONFIG`, `HOST`. | 01-datos |
| A7 | **Claim de slot = TransactWriteItems** con invariantes atómicas: CONFIG (reservas abiertas, idx≤N) + slot LIBRE + usuario sin reserva/cola/suspensión **+ rate-limit (cooldown, encendidos/día)**. | 01-datos + corrección |
| A8 | **Reconciliación desired-state**: la nube escribe lo deseado, el agente reporta lo real. Sin cola de mensajes. Control-plane y runtime son atributos disjuntos. | 01-datos, 02-estados |
| A9 | **La SPA nunca toca DynamoDB**: todo por Lambda Function URLs detrás de CloudFront. Sesión en **cookie**, nunca header `Authorization` (reservado por OAC/SigV4). | 06-infra + corrección |
| A10 | Máquina de estados del intent: SOLICITADO→DESPERTANDO→BOOTEANDO→INICIANDO→VERIFICANDO→LISTO, más EN_COLA/FALLIDO/CANCELADO/EXPIRADO. Dos perfiles: AWAKE ~45s, ASLEEP ~3min. **No hay perfil ~5s** (handover siempre `systemctl restart` → server limpio). | 02-estados |
| A11 | **Un solo EventBridge Scheduler** `rate(1 minute)` → reaper (intents colgados, expiración de turnos de cola, malla WoL, **sweep de CERRANDO**). Sin schedules one-shot por-intent. TTL solo backstop. | 02-estados, 06-infra |
| A12 | WoL: Lambda `dgram` sin dependencias manda magic packet (102 B) a `home.l4d2.ventrax.dev:9` (fallback `HOST.publicIp`), offsets escalonados 0–120s; éxito = heartbeat del agente. | 02-estados, 04-agente |
| A13 | **Auto-apagado decidido por el agente** (funciona offline), pero **fail-SAFE**: default HOLD ante fallo de heartbeat, **boot-grace** 90–120s, y exige heartbeat fresco confirmando `hold_poweroff=false` antes de apagar. | 04/02 + corrección de 08 |
| A14 | Agente = **Python stdlib, un archivo**, systemd usuario `l4d2agent` no-root (grupo `steam`), sudo scoped vía wrapper `fleetctl`. Provisionado por Ansible extendiendo `l4d2-fleet`. | 04-agente, 08-fleet |
| A15 | **Un solo endpoint de agente** en v1 (`/agent/poll` lleva heartbeat+reporte); se baja el intervalo a ~4s durante un intent. Se descarta `/agent/report` separado. | recorte de 02/04 |
| A16 | **Comandos idempotentes con `cmd_id` + dedup persistido + ack**; `open_server` no reinicia si el slot ya está up con el admin correcto; deadline de START post-WoL 180–300s, re-emitido cada poll hasta ack. | corrección de 04/08 |
| A17 | Admin por-servidor = plugin **`fleet_admin.smx`** que discrimina por `hostport`, concede flags en runtime (Admin Cache API, sin tocar `admins_simple.ini` global), reservado en `gKeep` del `predictable_unloader` parcheado. Flags: **sin `d` (ban)**; set exacto configurable, a calibrar in-game. | 04/08 |
| A18 | Estado por-servidor en `addons/sourcemod/data/l4d2fleet/` + backup/restore stat-guarded de `admins_simple.ini` en `zonemod.yml` (sobrevive re-provisions). Con `with_agent=true` las units `l4d2@k` quedan **instaladas pero detenidas** (arranque bajo demanda). | 08-fleet |
| A19 | SourceBans++ 1.8.x + MariaDB local; el fix de LAC es **instalar `sourcebans.smx` + `databases.cfg`** para que `lilac_sourcebans=1` **persista** (hoy banea a la nada). Esquema/primer admin por el instalador web (una vez). | 05/08 |
| A20 | `/sourcebans` protegido por header secreto **`X-Origin-Verify`** que solo CloudFront inyecta (nginx 403 sin él); **obligatorio**, no opcional. Cert del origen por **Let's Encrypt DNS-01** vía Route53 con IAM acotado. | 05/08 + corrección |
| A21 | Wake-on-uso de `/sourcebans` **gateado server-side** (`POST /api/wake reason:"sourcebans"` exige flag operador); siembra un sostén `sourcebansWakeGrace = now+10min` independiente del access log. | 05 + corrección |
| A22 | Infra **CDK TS, 2 stacks**: `L4d2PanelCert` (us-east-1, solo ACM) + `L4d2PanelApp` (us-east-2, todo) con `crossRegionReferences`. Secretos en **SSM SecureString** (no Secrets Manager). CloudWatch Logs retención 14 días. Budget $1 + alarmas de uso. | 06/07 |
| A23 | Deep-link SPA por **CloudFront Function** (rewrite de rutas sin extensión → `/index.html`) solo en el behavior `/*`. **Se elimina** el mapeo global de custom-error-responses 403/404/502/503/504→index.html. | corrección de 05/06 |
| A24 | Origen caído de `/sourcebans` → **Origin Group** con failover a S3 (`/despertando.html`), scoped al behavior `/sourcebans*`. No error-responses globales. | corrección de 05/06 |
| A25 | Endpoint `agent` = Function URL **authType NONE** con **resource policy `AWS:SourceIp` = IP pública de casa (obligatoria)**; el rechazo es pre-invocación (no en el handler). Bearer sobre TLS; **sin HMAC** en v1 (rompe con el skew de reloj post-WoL). | corrección de 04/06 |

---

## 4. Contradicciones entre dominios y su resolución

Esta es la sección de mayor valor: cada dominio declaró *dependencias* asumiendo cosas que otro no
contempla. Aquí se cruzan y se decide.

**C1 — ¿GSI o no GSI? (datos vs estados-api).**
`01-datos` fija **cero GSI** (el free tier de 25/25 es agregado; un GSI provisionado lo rompe).
`02-estados-api` asume un **`GSI1 (INTENT_ACTIVE)` para el reaper**. Contradicción dura.
**Resolución: cero GSI manda (A5).** El reaper no necesita GSI a escala hobby: los intents activos se
resuelven o bien con un **Scan acotado** de la tabla (decenas de ítems) filtrando no-terminales, o bien
consultando la partición de intents por prefijo. El reaper corre 1/min sobre <100 ítems: el costo es
despreciable y cabe de sobra en 25 RCU. Se reescribe la dependencia de `02` para no depender de GSI.

**C2 — ¿Quién decide el poweroff? (agente/estados vs fleet).**
`04-agente` y `02-estados` dicen que el **agente decide localmente** (funciona offline, tiene la foto
real de jugadores/SSH). `08-fleet` marca **CRÍTICO** que el agente hace fail-**open** (si el heartbeat
falla → `data={}` → `hold_cloud=False` → apaga) y propone mover el poweroff a **comando exclusivo de la
nube**.
**Resolución (A13): el agente conserva la autoridad local, pero fail-SAFE.** Mover el poweroff 100% a
la nube pierde la ventaja de apagar sin internet y arriesga apagar con jugadores por desfase. Se corrige
el defecto real: (a) ante cualquier fallo/timeout de heartbeat, **default HOLD** (no apagar); (b)
**boot-grace** 90–120s de uptime mínimo antes de permitir apagado; (c) exigir **un heartbeat exitoso y
fresco inmediatamente antes** del poweroff que confirme `hold_poweroff=false`. Así se cierra la ventana
de la reserva recién llegada sin renunciar a la operación offline.

**C3 — Co-tenencia de la PC (agente + fleet, CRÍTICO doble).**
Ambos dominios detectan que `192.168.18.100` es la **misma** máquina que hospeda **InfoGestion**
(`infogestion.ventrax.dev:444`, Docker/MySQL, 24/7) y el stack de monitoreo (Grafana/Prometheus/Loki).
Ningún sostén contempla esos servicios.
**Resolución: BLOQUEANTE de producto (ver §9-a-B1).** El diseño de auto-apagado es **incompatible** con
el estado real del host tal cual. No se implementa el poweroff hasta decidir: (a) PC **dedicada**
distinta; (b) `suspend/hibernate` en vez de `poweroff` (pero entonces el WoL despierta de suspend y el
modelo cambia); o (c) sostén explícito que consulte actividad de InfoGestion (puerto 444/contenedor) y
nunca apague con servicios 24/7 activos. El default recomendado (§9) es un **sostén de InfoGestion**
mientras no haya máquina dedicada.

**C4 — IP estática vs dinámica y el DDNS (sourcebans + fleet vs memoria).**
`05` y `08` construyen maquinaria de **DDNS por heartbeat** asumiendo IP dinámica; la **memoria del
entorno** dice **"IP estática con forwards ISP→.100"**. Además ambos marcan el **deadlock**: con la PC
apagada, si el ISP rota la IP, el WoL va a una IP obsoleta y nadie puede corregir (la PC está apagada).
**Resolución: BLOQUEANTE (ver §9-a-B2).** Primero **verificar** si la IP es realmente estática. Si es
estática → **eliminar todo el DDNS por heartbeat** (sobre-ingeniería y superficie IAM innecesaria): un
**A fijo** en Route53. Si es dinámica → el DDNS **debe vivir en el router** (independiente del estado de
la PC); el heartbeat-DDNS por sí solo **no** cierra el hueco de "IP cambia con la PC apagada". El
heartbeat-DDNS queda solo como conveniencia secundaria, nunca como único mecanismo.

**C5 — Nombre del hostname de origen (cuatro nombres distintos).**
`03`/`02` usan `home.l4d2.ventrax.dev`; `05`/`06` usan `home.ventrax.dev`; `07` usa
`home-l4d2.ventrax.dev`; `08` usa `origin-sb.ventrax.dev`.
**Resolución: se estandariza `home.l4d2.ventrax.dev`** en todo el proyecto (WoL fallback, origen de
CloudFront, cert LE, DDNS). **Ojo:** la política IAM de Let's Encrypt DNS-01 debe permitir el TXT
`_acme-challenge.home.l4d2.ventrax.dev` **y** `route53:ListHostedZones` (hallazgo ALTO de `07`).

**C6 — Front lee DynamoDB directo vs vía Lambda.**
`01-datos` (§6.1 y tabla de AP) describe al **front haciendo `Query PK=SLOT` directo**; sin Cognito la
SPA **no tiene credenciales AWS**.
**Resolución (A9): el front nunca toca DynamoDB.** Toda lectura pasa por la Lambda `api`. Se corrige la
tabla de patrones de `01`. Consecuencia de costo: el polling genera invocaciones Lambda (ver C7).

**C7 — Análisis de costo: DynamoDB-only (datos) vs Lambda+Logs (costos).**
`01-datos` (§9) argumenta ~$0 **solo** sobre capacidad DynamoDB e ignora Lambda + CloudWatch Logs, que
es donde el ~$0 se rompe (polling sostenido → invocaciones y GB de logs).
**Resolución: `07-costos` es autoritativo en costo.** El análisis de `01` queda subordinado. Reglas
duras: (a) **no loguear en el hot-path** del poll (WARN/ERROR, una línea por evento de negocio); (b)
**retención 14 días**; (c) polling adaptativo con **Page Visibility** (pausa con pestaña oculta). El
"cache de `/api/servers` en CloudFront" de `07` se trata como **opcional anti-viralidad**, no como
requisito (ver §6), y **solo** si ese endpoint es 100% anónimo.

**C8 — Custom error responses: global (datos/infra) vs coherencia de /sourcebans y /api.**
`06-infra` mapea 403/404/502/503/504→`index.html(200)` **global a la distribución**; `05` y `06` mismos
marcan ALTO que eso **rompe el PHP de SourceBans** (un 404/403 legítimo del panel devuelve la SPA) **y**
rompe el parseo JSON de `/api` (un 502 del Lambda devuelve HTML con 200).
**Resolución (A23/A24):** se **elimina** el mapeo global. Deep-link SPA por **CloudFront Function**
(rewrite → `/index.html`) solo en `/*`. Origen caído de `/sourcebans` por **Origin Group** con failover
a S3 (`/despertando.html`) scoped al behavior. El wake ya es SPA-first, así que 502/503/504→index.html
es innecesario.

**C9 — Endpoint del agente: público authType NONE (infra) vs origen forwardeado sin filtro (fleet).**
`06` marca que una Function URL NONE **se cobra antes** de comparar el token (abuso = invocaciones
facturables); `08` marca que el puerto forwardeado a nginx es alcanzable por cualquiera saltándose
CloudFront.
**Resolución (A25 + A20):** (a) el endpoint `agent` mantiene NONE pero con **resource policy
`AWS:SourceIp` = IP pública de casa, obligatoria** (rechazo pre-invocación, a nivel infra, no en el
handler); (b) **nginx exige `X-Origin-Verify` obligatorio** (403 sin él), cerrando el bypass de
CloudFront. Ambos controles dejan de ser "opcionales/endurecibles" y pasan a ser requisitos.

**C10 — Doble escritor de asignación de slot (infra vs datos/estados).**
`06` marca que `api` (asigna directo) y `reaper` (promueve cola) son **dos escritores sin coordinación**
→ doble-asignación / queue-jumping.
**Resolución:** **toda** transición de slot usa **escrituras condicionales** (`TransactWriteItems`
condicionando `estadoReserva=LIBRE`, ya en `01`). La promoción de cola condiciona `Delete` de la cabeza
+ slot LIBRE + `colaSeq` del head; solo uno gana. `api` y `reaper` pueden coexistir porque **ambos
compiten por la misma condición atómica** sobre el slot; el perdedor reintenta. Se documenta como
contrato duro con el dominio de datos (no "Scan basta").

**C11 — HMAC anti-replay (agente) vs skew de reloj post-WoL (agente, auto-contradicción).**
`04` propone HMAC ±300s y a la vez reconoce que el RTC puede driftar >300s tras días apagado → el HMAC
rechaza todo y los deadlines se evalúan con reloj sucio.
**Resolución (A25):** **sin HMAC en v1** (Bearer sobre TLS basta para el modelo de amenaza declarado).
Además: unit con `After=time-sync.target`; el agente calcula `offset = server_time(respuesta) −
time.time()` y corrige todas las comparaciones de deadline con ese offset.

**C12 — Deadline de comando 60s vs arranque en frío (agente).**
El START emitido junto al WoL con `deadline=issued_at+60s` expira antes del primer poll (NIC 15-30s +
boot + red > 60s).
**Resolución (A16):** deadline de START post-WoL **180–300s** y la nube **re-emite** el comando (mismo
`cmd_id`) en cada poll hasta ver el ack, en vez de expirarlo.

**C13 — Host WAKING reseteado a DOWN por heartbeat viejo (estados, CRÍTICO).**
El tick normaliza Host→DOWN si `now−lastHeartbeat>90s` sin excluir WAKING; durante un wake ASLEEP el
heartbeat es viejísimo por definición.
**Resolución:** el tick **solo** demota UP→DOWN por heartbeat viejo; **nunca toca WAKING** por
`lastHeartbeat`. WAKING solo cae a DOWN si no hay intent en DESPERTANDO y `now−wakeStartedAt>150s`.

**C14 — PC muere con slots ACTIVO → flota fantasma (estados, CRÍTICO).**
Si la PC cae con slots ocupados, Host→DOWN pero los slots quedan ACTIVO; el único que los libera es el
agente (muerto) → cola congelada, deadlock.
**Resolución:** cuando el tick lleva Host UP→DOWN por heartbeat viejo, **resetea todos los slots
no-LIBRE a LIBRE**, lleva los intents dueños a FALLIDO (`HOST_UNREACHABLE`) y **promueve la cola** (que
ahora ve slots libres y dispara WoL por el flujo ASLEEP).

**C15 — Se viola "1 servidor por usuario" al limpiar activeIntentId en LISTO (estados, CRÍTICO).**
`02` limpia `activeIntentId=null` al llegar a LISTO (terminal); tras LISTO el usuario sigue siendo dueño
del slot pero sin candado → puede reservar un segundo.
**Resolución:** **no** limpiar `activeIntentId` en LISTO; solo en CANCELADO/FALLIDO/EXPIRADO y en
`/api/close`. Redundante con A7 (el claim ya condiciona `attribute_not_exists(slotActual)`), pero se
corrige en ambos lados (datos y estados) para defensa en profundidad.

**C16 — INTENT residual bloquea nuevas reservas / puntero colgante (datos + estados, ALTO).**
Un INTENT en ERROR (vive hasta TTL 60min) bloquea el `Put attribute_not_exists(SK)` del claim; un
`activeIntentId` seteado antes de crear el Intent queda colgante y bloquea permanentemente.
**Resolución:** el claim **limpia/sobrescribe** cualquier intent previo en la **misma** transacción
(Put sin `attribute_not_exists` o delete de ERROR/CANCELADO); Intent + puntero User se escriben
**atómicamente**; al leer un `activeIntentId` cuyo intent no existe o es terminal, tratar como sin-candado
y **self-heal**. CANCELAR = release completo atómico (REMOVE slotActual + slot→LIBRE/CERRANDO + delete
INTENT).

**C17 — CERRANDO sin backstop → cola congelada (datos, ALTO).**
La liberación en dos fases deja el slot en CERRANDO; si el agente muere o la PC se apaga antes de la
Fase 2, el slot queda CERRANDO para siempre y la cola no avanza.
**Resolución:** (a) el agente **barre CERRANDO al arrancar** (completa Fase 2 → LIBRE → promueve); (b)
el tick fuerza la limpieza tras N minutos en CERRANDO; (c) **CERRANDO cuenta como sostén** de
auto-apagado hasta completar la Fase 2 (se refleja en `hold_poweroff`).

**C18 — Rate-limit decorativo fuera del claim (datos + agente, ALTO/abuso).**
`cooldownSegundos` y `maxEncendidosDia/encendidosHoy` se definen pero **no** se validan dentro del claim
atómico → dos requests concurrentes pasan el check-then-act y ambas encienden la PC. Con registro
abierto, es el único guardarraíl contra power-cycling desde internet.
**Resolución (A7):** **hornear el rate-limit en la transacción**: añadir a la condición del perfil
`(attribute_not_exists(ultReserva) OR ultReserva < :nowMenosCooldown)` y gestionar `encidosHoy` con
`ADD encendidosHoy :one` condicional (`encendidosHoy < maxEncendidosDia`), con reset lazy por
comparación de fecha. Sin esto los límites son decorativos. **Es la defensa dura del WoL.**

**C19 — Wake por reason:sourcebans sin sostén (sourcebans, ALTO).**
El sostén #3 solo se activa **tras** el primer hit al access log; entre "PC online, wakeInProgress=false"
y el primer hit hay una ventana donde el agente concluye "sin sostenes" y apaga en la cara del operador.
**Resolución (A21):** el wake `reason:"sourcebans"` siembra `HOST.sourcebansWakeGrace = now+10min` que
el bucle de auto-apagado respeta, independiente del access log.

**C20 — Reclamo de turno de cola sin guarda condicional (estados, ALTO).**
T14 (usuario reclama turno) y T15 (tick expira turno) pueden correr casi simultáneos sobre el mismo slot
RESERVADO_COLA → dos dueños.
**Resolución:** T14 hace `UpdateItem` con `ConditionExpression: estado='RESERVADO_COLA' AND
claimSteamId=:me AND claimDeadline > :now`; si falla → 409/EXPIRED. T15 condiciona su expiración a
`estado='RESERVADO_COLA'` vigente.

**C21 — Ventana de carrera del auto-apagado por Host.state stale (estados, ALTO).**
Tras el poweroff, `Host.state` sigue UP hasta 90s; en esa ventana todo reserve nuevo se clasifica AWAKE
y encola `boot_server` que nadie ackea → BOOT_TIMEOUT → FALLIDO repetido.
**Resolución:** en el reaper, al llevar un intent a BOOT/START_TIMEOUT, si `now−Host.lastHeartbeat >
umbral (~25s)`, marcar Host **DOWN de inmediato** y re-encolar el intent como ASLEEP (disparar WoL) en
vez de FALLIDO seco. Bajar el umbral de normalización.

**C22 — Cookie de sesión: `l4d2_session` (auth) vs `l4d2p_session` (infra).**
**Resolución: `l4d2_session`** en todo el proyecto (A3). HttpOnly, Secure, SameSite=Lax, reenviada por
CloudFront con `ALL_VIEWER_EXCEPT_HOST_HEADER`; **nunca** header `Authorization` (reservado por OAC).

**C23 — Set de flags del admin por-servidor: `bcfgij` (agente) vs `bcgjk` (fleet).**
Ambos coinciden en **excluir `d` (ban)** por D3, pero difieren en el resto.
**Resolución:** el **invariante duro** es "sin `d`". El set exacto es **configurable** (`reserver_flags`
en `agent.conf`) y se **calibra in-game** contra lo que exige `!match`/`!unmatch`/`!forcestart` de
ZoneMod. No se fija en piedra hasta probar en la caja.

**C24 — Idempotencia de comandos (fleet, ALTO).**
Los comandos llegan sin ID ni ack; `open_server` = `restart` destructivo → re-emisión expulsa a los
jugadores.
**Resolución (A16):** `cmd_id` + set de procesados **persistido en disco** + ack en el siguiente poll;
`open_server` idempotente (no reinicia si el slot ya está up con el admin correcto). Ata con C12/C16.

**C25 — Doble N (agente provisionado vs nube autoritativa) (fleet, sobre-ingeniería).**
El ida-y-vuelta de `server_count_provisioned` vs `server_count` en cada poll sobra.
**Resolución:** N autoritativo vive en **CONFIG (DynamoDB)** y llega en cada poll; el techo provisionado
por Ansible (units + sudoers) debe ser **≥ N**. El chequeo defensivo del agente se conserva, pero no se
negocian ambos valores; cambiar N es operación de operador (re-deploy Ansible si sube el techo).

---

## 5. Correcciones obligatorias (revisiones adversariales)

Consolidadas y dedupeadas por dominio. Todas **deben** quedar implementadas.

### Datos / transacciones
- **[C18] Rate-limit horneado en el claim**: cooldown + encendidos/día como `ConditionExpression` y
  `ADD` condicional atómicos. (ALTO ×2, es la defensa del WoL).
- **[C16] Intent residual y puntero colgante**: claim limpia intent previo en la misma transacción;
  Intent+puntero atómicos; self-heal al leer `activeIntentId` inválido; CANCELAR = release completo.
- **[C17] Backstop de CERRANDO**: sweep del agente al boot + forzado por tick + CERRANDO como sostén.
- **[C15] No limpiar `activeIntentId` en LISTO** (solo en terminales de fallo y en close).

### Máquina de estados / API
- **[C13] Host WAKING nunca se demota por heartbeat viejo**; solo UP→DOWN por heartbeat, WAKING por
  `wakeStartedAt`.
- **[C14] Host UP→DOWN resetea todos los slots a LIBRE + intents a FALLIDO + promueve cola** (mata la
  flota fantasma).
- **[C20] Guarda condicional en reclamo de turno (T14) y en expiración (T15)**.
- **[C21] Reaper marca Host DOWN inmediato y re-dispara WoL** ante BOOT/START_TIMEOUT con heartbeat
  viejo (evita cadena de FALLIDO en la ventana stale).

### Agente / local
- **[C2/A13] Auto-apagado fail-SAFE**: default HOLD ante fallo de heartbeat, boot-grace 90–120s,
  heartbeat fresco confirmatorio antes de apagar.
- **[C11] Sin HMAC en v1; `After=time-sync.target`; corrección de reloj por offset del server.**
- **[C12/C24] Comandos con `cmd_id` + dedup persistido + ack; deadline de START post-WoL 180–300s
  re-emitido; `open_server` idempotente.**

### SourceBans / routing / infra
- **[C8/A23] Eliminar custom-error-responses globales**; deep-link SPA por CloudFront Function.
- **[C8/A24] Origin Group scoped a `/sourcebans*`** con failover a S3 (`/despertando.html`).
- **[C9/A25] Endpoint agent: resource policy `AWS:SourceIp` obligatoria** (rechazo pre-invocación).
- **[C9/A20] nginx `X-Origin-Verify` obligatorio** (cierra el bypass del puerto forwardeado).
- **[C19/A21] `sourcebansWakeGrace` como sostén independiente del access log.**
- **[C5] Política IAM de LE DNS-01**: permitir TXT `_acme-challenge.home.l4d2.ventrax.dev` +
  `route53:ListHostedZones` (si no, `/sourcebans` da 502 permanente).

### Fleet (bloqueantes de producto)
- **[C3] Co-tenencia con InfoGestion**: no implementar poweroff hasta decidir (dedicada / suspend /
  sostén InfoGestion).
- **[C4] Fiabilidad del WoL con IP potencialmente cambiante y PC apagada**: verificar IP estática; si
  dinámica, DDNS en el router.

---

## 6. Recortes por sobre-ingeniería

- **Atributo de versión optimista `v`** en slots/HOST que **nunca** se usa en ninguna condición: o se
  usa de verdad o **se elimina** (todas las condiciones son sobre atributos de negocio).
- **PITR ON + Deletion Protection ON** para una tabla enteramente reconstruible (slots re-sembrados por
  script, perfiles re-upserteados en login, cola efímera, counter desde 0): **PITR OFF** por defecto
  (revalidar en B/§9). Mantener Deletion Protection es barato; PITR no aporta a datos regenerables.
- **Reset diario de `encendidosHoy` por Scheduler (Scan de usuarios)**: innecesario existiendo el
  **reset lazy** por comparación de `encendidosDia`. Un solo mecanismo.
- **Padding a 20 dígitos del seq de cola**: `pad10` sobra de por vida a escala hobby.
- **`/agent/report` separado**: se fusiona en `/agent/poll` (A15); menos routing/auth/shapes.
- **Doble mecanismo de reintento de WoL** (orquestador que "duerme" 0–120s **y** malla del tick): dejar
  que el **tick de 1 min** reenvíe mientras Host=WAKING; evita una Lambda async larga (más costo/duración
  y más superficie de fallo). *(Opcional: se puede conservar el escalonado corto dentro de una sola
  invocación si se quiere agilidad; no ambos caminos redundantes.)*
- **BOOTEANDO vs INICIANDO** como estados separados: la UI los colapsa siempre en "Iniciando"; se
  conservan como **sub-señales** internas del agente, no como dos celdas del stepper.
- **HMAC anti-replay** (ya en §5): fuera de v1 por fragilidad de reloj.
- **Rotación de token con doble-validez** (`token_hash`+`token_hash_next`): pesado para un único host;
  basta reiniciar el servicio tras cambiar el archivo.
- **DDNS "modo local" + "modo cloud"** implementados a la vez: **un solo modo** (el que decida C4);
  documentar el otro como idea, no mantener plantillas duplicadas.
- **Watchdog de matchmode "capa 2"** (especulativa, inimplementable con A2S): quitarla; la prevención
  por `restart` entre reservas ya elimina el bug de raíz.
- **Cache de `/api/servers` en CloudFront**: resuelve un no-problema a escala hobby e introduce riesgo
  de fuga de estado por-usuario. **No en v1** salvo que aparezca viralidad real; si se hace, exige
  contrato de endpoint **100% anónimo** (sin campos por-usuario, `Authorization`/`Cookie` fuera del
  cache key) y todo estado personal en un endpoint separado no cacheado.
- **Segunda línea de 4 alarmas de uso**: bastan **2** (IncomingBytes/día de Logs — la única trampa cara
  real — e Invocaciones/día). Las de throttle de DynamoDB en 25/25 con esta carga son casi inalcanzables.
- **Variable Ansible `agent_boot_start_units`** muerta (nunca usada): eliminarla.
- **Segundo `getUsuario` tras el upsert en login**: usar `ReturnValues=ALL_NEW` del `UpdateItem`.
- **`certbot.timer` 2x/día + oneshot al boot**: con PC intermitente basta el **oneshot al boot** (Caddy
  auto-renueva al arrancar); el timer aporta poco.

---

## 7. Riesgos consolidados (priorizados)

| # | Riesgo | Prob. | Impacto | Mitigación / estado |
|---|---|---|---|---|
| R1 | **WoL desde internet no despierta la PC** (IP obsoleta con PC apagada, o NIC 15-30s en modo WoL) → reserva muerta, cola atascada, sin diagnóstico | Media | Crítico | **C4/B2**: verificar IP estática; si dinámica, DDNS en el router (independiente de la PC). Magic packets escalonados 0–120s + malla del tick. Fallback `HOST.publicIp`. |
| R2 | **Capacidad real de la PC** (cuántas instancias L4D2 aguanta antes de fijar N) **agravada por co-tenencia** con InfoGestion/monitoreo 24/7 | Alta | Crítico | **C3/B1**: medir N en la caja; decidir dedicada/suspend/sostén InfoGestion **antes** de habilitar poweroff. N dinámico en CONFIG, arranca en 4. |
| R3 | **Abuso de encendido** (registro abierto + WoL-al-reservar = power-cycling desde internet: desgaste, luz, ruido) | Media | Alto | **C18/A7**: rate-limit horneado en el claim (cooldown + encendidos/día atómicos); interruptor global de reservas; flag `suspendido`. |
| R4 | **Auto-apagado apaga con reserva/jugadores en curso** (fail-open, ventana de carrera) | Media | Alto | **A13**: fail-safe (default HOLD), boot-grace, heartbeat fresco confirmatorio; CERRANDO como sostén. |
| R5 | **Deadlock de cola / flota fantasma** (PC cae con slots ACTIVO; CERRANDO sin backstop; Host WAKING reseteado) | Media | Alto | **C13/C14/C17**: reset de slots al caer Host, sweep de CERRANDO, WAKING intocable por heartbeat. |
| R6 | **`/sourcebans` expuesto por el puerto forwardeado**, saltándose CloudFront y el gate de operador | Media | Alto | **A20/C9**: `X-Origin-Verify` obligatorio en nginx; bind explícito; gate server-side de operador. |
| R7 | **Costo se dispara por CloudWatch Logs** (ingesta $0.50/GB) o **DynamoDB on-demand** | Baja | Medio | **C7**: no loguear en hot-path, retención 14d, provisioned 25/25 fijo; alarmas IncomingBytes + Invocaciones/día. |
| R8 | **Cert LE del origen vence** con PC apagada >30 días → `/sourcebans` 502 | Baja | Medio | Cert 90d, renueva a 60; oneshot al boot; la PC se enciende bastante más seguido que mensualmente. |
| R9 | **Comando `open_server` re-emitido expulsa jugadores** (no idempotente) | Media | Medio | **A16/C24**: `cmd_id` + dedup persistido + ack; `open_server` idempotente. |
| R10 | **Skew de reloj post-WoL** rompe deadlines/auth | Media | Medio | **A25/C11**: sin HMAC, `time-sync.target`, corrección por offset del server. |
| R11 | **Bug de matchmode de ZoneMod** (`!match`/`!unmatch` trabados en server vacío) | Media | Bajo | `systemctl restart` entre reservas estrena proceso limpio (elimina el candado heredado). |
| R12 | **`admins_simple.ini` global pisado** en cada re-provision | Alta | Bajo | Estado en `data/l4d2fleet/` + backup/restore stat-guarded + reseed idempotente. |

---

## 8. Plan de implementación por fases

**Principio de orden:** arrancar por lo que **desbloquea** al resto. El modelo de datos y la máquina de
estados son la columna vertebral; el front se construye **contra mocks en paralelo**; el componente
local (agente + Ansible) es el camino más largo y arriesgado (hardware real) y debe empezar temprano
pero puede madurar en paralelo.

**Fase 0 — Cerrar bloqueantes (antes de codear).** Resolver **B1 (co-tenencia)** y **B2 (IP)** de §9;
bootstrapear CDK en **us-east-1** (falta); confirmar cookie/hostname/nombres estandarizados. Sin esto, el
diseño de auto-apagado y WoL no es implementable con garantías.

**Fase 1 — Cimiento (camino crítico).**
- **1a. Datos**: crear la tabla `l4d2-panel` (CDK, 25/25, 0 GSI, TTL, PITR OFF), sembrar SLOT/CONFIG,
  implementar los `TransactWriteItems` de claim (con rate-limit horneado), promoción de cola,
  liberación en dos fases y self-heal de intents. **Desbloquea todo lo demás.**
- **1b. Máquina de estados + API** (`api`, `reaper`, `wol`, `auth`): endpoints públicos y de agente,
  el tick de 1 min, y las correcciones C13/C14/C20/C21. Depende de 1a.
- **En paralelo — Front contra mocks**: la SPA (lista de servidores, stepper de reserva, cola,
  `/despertando.html`) se construye contra un contrato de API mockeado desde el día 1; no espera al
  back real.
- **En paralelo — Auth Steam**: Lambda `auth` (login/return, JWT, cookie). Independiente salvo el
  layout de USER en 1a.

**Fase 2 — Infra y pegado en la nube.** CDK completo (dos stacks, CloudFront con OAC y los behaviors,
CloudFront Function de deep-link, Origin Group de `/sourcebans`, Function URLs con la resource policy
del agente, SSM, Scheduler, Budget/alarmas). Publicar la SPA. Cablear el front real contra la API.
Depende de Fase 1.

**Fase 3 — Componente local (puede empezar en Fase 1, madura aquí).**
- **3a. Ansible/fleet**: MariaDB + SourceBans++ (fix de LAC), plugin `fleet_admin.smx` (admin
  por-puerto, gKeep), estado en `data/l4d2fleet/`, units bajo demanda, sudoers/wrapper `fleetctl`.
- **3b. Agente Python**: polling, comandos idempotentes, sostenes, auto-apagado fail-safe, cliente
  RCON, watchdog de churn. Depende del contrato de API (Fase 1b) y de 3a.
- **3c. nginx `/sourcebans` + cert LE DNS-01** con `X-Origin-Verify`. Depende de la IAM de LE (C5).

**Fase 4 — Integración end-to-end en la caja real.** WoL desde internet (prueba limpia post-arreglo de
booteo), medir capacidad → fijar N, calibrar `reserver_flags` in-game, verificar sostenes (SSH,
SourceBans, InfoGestion), timing del ciclo completo AWAKE/ASLEEP. Aquí se cierran R1/R2/R11.

**Camino crítico:** Fase 0 → 1a (datos) → 1b (estados/API) → 3b (agente) → Fase 4 (integración real).
El front (mocks), auth y Ansible/fleet **se paralelizan** y convergen en Fase 2/4. El mayor riesgo de
cronograma es la Fase 4 (hardware real: WoL, capacidad, matchmode), por eso 3a/3b deben empezar temprano
aunque el resto no esté listo.

---

## 9. Preguntas abiertas para el usuario

### (a) BLOQUEANTES — hay que resolverlas antes de construir

**B1. ¿La PC del panel es DEDICADA a L4D2, o comparte máquina con InfoGestion + monitoreo 24/7?**
El auto-apagado por sostenes, tal cual, **apagaría InfoGestion** (`infogestion.ventrax.dev:444`) y el
stack Grafana/Prometheus/Loki. Recomendación: si no puede haber una segunda máquina dedicada, **agregar
un sostén explícito de InfoGestion** (consultar actividad del contenedor/puerto 444 y **nunca** apagar
con servicios 24/7 activos). Alternativa: `suspend/hibernate` en vez de `poweroff` (pero el WoL debe
despertar de suspend y cambia el modelo). *Mi recomendación: sostén InfoGestion en v1 (menos fricción),
migrar a máquina dedicada cuando se pueda.*

**B2. ¿La IP pública de casa es ESTÁTICA (como dice la memoria) o dinámica?**
Define toda la maquinaria de DDNS y la fiabilidad del WoL con la PC apagada. Si es **estática** →
**eliminar** el DDNS por heartbeat (sobre-ingeniería + superficie IAM) y usar un **A fijo**. Si es
**dinámica** → el DDNS **debe ir en el router** (el heartbeat no cubre "IP cambia con PC apagada", que
causa deadlock de WoL). *Mi recomendación: verificarla en la caja hoy; si es estática, simplificar
drásticamente (A fijo, sin route53:Change en el agente).*

### (b) IMPORTANTES — con default propuesto (decidibles rápido)

**B3. Promoción de cola: ¿auto-asignar (arrancar el server del primero aunque esté AFK) o ventana de
aceptación con hold de 180s?** *Default: auto-asignar en v1* (más simple; el aviso es solo en web). Los
campos del hold ya quedan en el modelo por si se quiere después.

**B4. ¿El agente escribe DynamoDB directo (IAM user acotado) o siempre vía Lambda + token?** *Default:
vía Lambda* (sin credenciales AWS en la PC de casa; consistente con todo el diseño).

**B5. Set exacto de flags del reservador.** El invariante es "sin `d` (ban)". *Default: `bcgjk`
configurable*, calibrar in-game contra `!match`/`!unmatch`.

**B6. Algoritmo/TTL del JWT.** *Default: HS256, TTL 7 días con renovación deslizante, secreto en SSM.*

**B7. Cadencia de polling del front.** *Default: 15s reposo, 4s durante intent, pausa con pestaña oculta
(Page Visibility).*

**B8. Retención de logs y PITR.** *Default: Logs 14 días, PITR OFF (tabla regenerable), Budget $1.*

### (c) DIFERIBLES — no bloquean v1

**B9. ¿Endurecer la sesión del operador** (TTL corto o step-up)? *Default: no en v1* (el operador es el
dueño de la PC; blast radius bajo).

**B10. Tope práctico de N y ancho de padding.** Para hobby, N pequeño y `pad10` sobran; revisar solo si
crece.

**B11. Limpiar el baseline preexistente** (~$0.87/mes: snapshots RDS huérfanos en us-east-1/us-east-2).
No afecta el proyecto pero es ~$4.4/año de desperdicio; si se limpia, bajar el Budget a $0.50.

**B12. Cache de `/api/servers`** (solo si aparece viralidad real) y **CI/CD del front** (OIDC con
aprobación manual): diferibles hasta que haya tráfico/necesidad.
