# 02 — Máquina de estados, orquestación del wake, cola y API

> Dominio **estados-api** del diseño técnico de **L4D2 Panel**.
> Cubre: la máquina de estados del *intent* de reserva, la orquestación del encendido por
> Wake-on-LAN, la cola FIFO, el contrato completo de la API (Lambda Function URLs), el polling del
> front y los *schedules* de EventBridge.
>
> Fuente de verdad de requisitos: `../especificaciones-v1.md`. Este documento es implementable tal
> cual; donde toca otro dominio (modelo de datos DynamoDB, auth Steam, agente/plugins locales,
> infra CDK) se declara el **supuesto** y el **contrato mínimo** que necesito, sin re-diseñarlo.
>
> Ambición: proyecto hobby (pocos servidores, decenas de usuarios, costo ~$0). Se prioriza lo
> simple y robusto sobre lo "correcto en el límite".

---

## 0. Supuestos y dependencias de otros dominios

Estos son los contratos que asumo; si el dominio dueño decide otra cosa, solo cambian nombres, no
la lógica de este documento.

| # | Supuesto | Dominio dueño |
|---|---|---|
| S1 | **DynamoDB single-table** `l4d2-panel`, PK/SK genéricos + un GSI `GSI1(GSI1PK, GSI1SK)` para escaneos por estado. Los *shapes* de item que uso están en §1; el dominio de datos fija las claves finales. | datos |
| S2 | **Auth de jugador**: una Lambda de login Steam emite un **JWT propio** (HS256 o EdDSA) con claim `sub = SteamID64`, `op` (bool operador), `sus` (bool suspendido), `exp`. Se manda en `Authorization: Bearer <jwt>`. Yo solo lo **verifico** (firma + exp) en cada request `/api/*`; no lo emito. | auth-steam |
| S3 | **Agente local**: proceso systemd en la PC (no root) que hace *polling* saliente HTTPS. Ejecuta comandos (`boot_server`, `close_server`, `reseed_admin`), reporta estado A2S/systemd, y **decide el `poweroff`** con sus sostenes locales. Contrato en §9. | local-agente |
| S4 | **Admin por-servidor**: existe (o existirá) un plugin `panel_admin.smx` que da admin *scoped* al `hostport` de su instancia leyendo un archivo por-puerto que el agente escribe; se agrega a `gKeep[]` del `predictable_unloader`. Yo solo requiero del agente un **ack booleano `adminSeeded`** en `VERIFICANDO`. El *cómo* es del dominio local. | local-plugins |
| S5 | **DDNS**: existe un hostname `home.l4d2.ventrax.dev` que resuelve a la IP pública de casa, **actualizado por el router** (no por la PC), para que el WoL y `steam://connect` funcionen aunque la PC esté apagada. Si el DDNS solo lo actualizara la PC, ver el *fallback* en §6.4. | infra |
| S6 | **Infra CDK**: crea las Lambdas, sus Function URLs, la tabla, el schedule `l4d2-tick`, la distribución CloudFront y los secretos. Nombres lógicos sugeridos en §13. | infra-cdk |
| S7 | **Secreto del agente**: string aleatorio en SSM SecureString `/l4d2-panel/agent-token`, inyectado como env `AGENT_TOKEN` a la Lambda `agent` y en el `agent.env` (Ansible vault) del agente. Comparación en tiempo constante. | infra / local |
| S8 | **Puerto de juego** de la instancia `k` = `PORT_BASE + k` con `PORT_BASE = 6032` (del `fleet.env`). Instancias `1..N` → `6033..6032+N`. `k` = índice del slot. | local (hecho) |

---

## 1. Entidades que toca este dominio (shapes mínimos)

Solo describo los atributos que la API/estado consume. El modelado final de claves/GSI es del
dominio de datos (S1). Todos los timestamps son **epoch en milisegundos** salvo que se diga.

### `Host` (singleton)
```jsonc
{
  "pk": "HOST#home", "sk": "HOST#home",
  "state": "DOWN | WAKING | UP",
  "lastHeartbeat": 1733600000000,   // último /agent/poll
  "publicIp": "1.2.3.4",            // reportado por el agente
  "wakeStartedAt": 1733600000000,   // inicio del wake singleton en curso (o null)
  "lastWolSentAt": 1733600000000,   // último magic packet
  "sourcebansLastUsed": 0,          // lo setea la Lambda de /sourcebans wake (sostén #3)
  "sshActive": false,               // lo reporta el agente (sostén #4)
  "updatedAt": 1733600000000
}
```

### `Config` (singleton)
```jsonc
{
  "pk": "CONFIG", "sk": "CONFIG",
  "n": 4,                     // tope de servidores (DINÁMICO; nunca hardcodear 4)
  "reservasEnabled": true,    // interruptor global (§15 spec)
  "maxWakesPerDay": 20,       // límite anti-abuso por usuario
  "cooldownSec": 20,          // cooldown entre operaciones del mismo usuario
  "claimWindowSec": 180,      // ventana para reclamar turno de cola
  "emptyCloseSec": 900        // 15 min: cierre de servidor vacío (referencia; lo aplica el agente)
}
```

### `Slot` (uno por índice `1..N`)
```jsonc
{
  "pk": "SLOT#1", "sk": "SLOT#1",
  "index": 1,
  "port": 6033,
  "estado": "LIBRE | PREPARANDO | ACTIVO | VACIO | RESERVADO_COLA | CERRANDO",
  "ownerSteamId": "76561198000000000",  // o null
  "intentId": "int_abc",                 // intent que lo está preparando (o null)
  "since": 1733600000000,                // desde cuándo es ACTIVO
  "emptySince": null,                    // desde cuándo VACIO (para el timer de 15 min del agente)
  "map": "c2m1_highway",
  "players": 3, "bots": 4, "maxPlayers": 8,
  "claimSteamId": null,                  // usuario con turno reservado (RESERVADO_COLA)
  "claimDeadline": null,                 // epoch límite para reclamar
  "updatedAt": 1733600000000
}
```
Semántica de `estado`:
- **LIBRE**: sin dueño, instancia detenida (o se detendrá). Disponible para asignar.
- **PREPARANDO**: asignado a un intent en `BOOTEANDO/INICIANDO/VERIFICANDO`.
- **ACTIVO**: entregado (intent `LISTO`), con dueño.
- **VACIO**: ACTIVO pero sin humanos; `emptySince` corriendo (el agente lo cierra a los 15 min).
- **RESERVADO_COLA**: liberado y reservado para el primero de la cola durante `claimWindow`.
- **CERRANDO**: el agente lo está deteniendo.

### `Intent` (uno por reserva)
```jsonc
{
  "pk": "USER#76561198000000000", "sk": "INTENT#int_abc",
  "id": "int_abc",
  "steamId": "76561198000000000",
  "slotIndex": 1,                 // asignado (o null si EN_COLA sin slot)
  "estado": "SOLICITADO | EN_COLA | DESPERTANDO | BOOTEANDO | INICIANDO | VERIFICANDO | LISTO | FALLIDO | CANCELADO | EXPIRADO",
  "profile": "AWAKE | ASLEEP",    // perfil de duración; determina si hay etapa DESPERTANDO
  "connectUrl": null,             // "steam://connect/home.l4d2.ventrax.dev:6033" en LISTO
  "errorCode": null, "errorMsg": null,
  "createdAt": 1733600000000,
  "updatedAt": 1733600000000,
  "stateDeadline": 1733600150000, // epoch límite del estado actual (para el reaper)
  // GSI1 para el reaper: solo se pobla si NO es terminal
  "GSI1PK": "INTENT_ACTIVE", "GSI1SK": "1733600150000#int_abc"
}
```
Cuando el intent llega a un estado **terminal** (`LISTO/FALLIDO/CANCELADO/EXPIRADO`) se **borran**
`GSI1PK/GSI1SK` (así el reaper solo escanea no-terminales). El puntero de "intent activo del
usuario" vive en el item `User` (`activeIntentId`) para el candado de idempotencia (§4.1).

### `QueueEntry`
```jsonc
{
  "pk": "QUEUE", "sk": "POS#0001733600000000#76561198000000000",  // FIFO por epoch-ms de ingreso, zero-padded
  "steamId": "76561198000000000",
  "joinedAt": 1733600000000,
  "estado": "ESPERANDO | PROMOVIDO",
  "slotIndex": null,           // set al promover
  "claimDeadline": null        // set al promover
}
```
FIFO = `Query(pk="QUEUE")` ordenado por `sk` ascendente. El primero es la cabeza.

### `User` (perfil)
```jsonc
{
  "pk": "USER#76561198000000000", "sk": "PROFILE",
  "nick": "...", "avatar": "https://...",
  "operador": false, "suspendido": false,
  "activeIntentId": null,      // candado 1-reserva-por-usuario
  "wakesToday": 0, "wakeDay": "2026-08-07",  // rate-limit de encendidos
  "lastOpAt": 0,               // cooldown
  "createdAt": 1733600000000
}
```

---

## 2. Máquina de estados del *intent* OPEN

### 2.1 Diagrama ASCII

```
                          reservar (POST /api/reserve)
                                     │
                                     ▼
                          ┌────────────────────┐
                          │     SOLICITADO     │  router SÍNCRONO dentro del request (<1s)
                          └──┬───────┬───────┬─┘
             slot libre &    │       │       │   todos los N ocupados
             Host=UP         │       │       └──────────────────────────┐
                             │       │ slot libre & Host=DOWN/WAKING     │
                             │       ▼                                   ▼
                             │  ┌──────────────┐  Host=UP        ┌───────────────┐
                             │  │  DESPERTANDO │  (heartbeat)    │    EN_COLA    │◄──┐
                             │  │  (WoL→hb)    │────────┐        └───┬───────┬───┘   │ promover
                             │  └──────┬───────┘        │            │       │       │ siguiente
                             │         │ timeout        │   claim &  │       │ leave │
                             │         ▼                │   Host=UP  │       │ /expira│
                             │      FALLIDO             │            │       ▼       │
                             │                          ▼            │  ┌──────────┐ │
                             ▼                    ┌──────────────┐   │  │ EXPIRADO │ │
                          ┌────────────────┐◄─────┤  BOOTEANDO   │◄──┘  └──────────┘ │
                          │   BOOTEANDO    │      │ (srcds vivo) │                   │
                          └──────┬─────────┘      └──────────────┘                   │
                                 │ srcds ActiveState=active                          │
                                 ▼                                                   │
                          ┌────────────────┐                                         │
                          │    INICIANDO   │ A2S responde (mapa cargado)             │
                          └──────┬─────────┘                                         │
                                 ▼                                                   │
                          ┌────────────────┐                                         │
                          │   VERIFICANDO  │ plugins OK + adminSeeded=true           │
                          └──────┬─────────┘                                         │
                                 ▼                                                   │
                          ┌────────────────┐   al cerrar/vaciar → Slot vuelve LIBRE ─┘
                          │      LISTO      │   (dispara promoción de cola)
                          │  (terminal ✓)   │   steam://connect entregado
                          └────────────────┘

   Reglas transversales:
   · Cualquier estado NO terminal ──(usuario cancela / cierra)──► CANCELADO (terminal)
   · DESPERTANDO/BOOTEANDO/INICIANDO/VERIFICANDO ──(deadline o error)──► FALLIDO (terminal)
   · FALLIDO ──(usuario "Reintentar")──► nuevo Intent (id nuevo)
```

**Nota sobre `BOOTEANDO`** (del enunciado): lo conservo como estado propio porque tiene una
señal observable distinta a `DESPERTANDO` — `DESPERTANDO` termina con el **heartbeat** del agente
(la PC arrancó el SO), y `BOOTEANDO` termina cuando el agente confirma `systemctl is-active
l4d2@k = active` (el proceso `srcds` ya existe pero **aún no responde A2S**). En el **perfil PC
despierta** se salta `DESPERTANDO` pero **sí** se pasa por `BOOTEANDO` (el hueco entre despachar
el comando y que el proceso esté vivo, ~1 ciclo de poll). En el **stepper** que ve el usuario,
`BOOTEANDO` e `INICIANDO` se pintan como una sola celda "Iniciando" (§3.2).

### 2.2 Estados: quién dispara, timeout, terminalidad

| Estado | Tipo | Lo dispara | Señal de salida (éxito) | Timeout típico | Deadline (ceiling) | Al vencer |
|---|---|---|---|---|---|---|
| `SOLICITADO` | transitorio | usuario (`/api/reserve`) | resolución síncrona del router | <1 s | n/a (síncrono) | — |
| `EN_COLA` | espera | backend (router) | promoción + claim del usuario | — | sin límite mientras N ocupados | — |
| `DESPERTANDO` | activo | backend (perfil ASLEEP) | agente manda heartbeat → `Host.state=UP` | 60–90 s | **150 s** | `FALLIDO` |
| `BOOTEANDO` | activo | backend/heartbeat | agente reporta `l4d2@k active` | 5–15 s | **40 s** | `FALLIDO` |
| `INICIANDO` | activo | agente (proceso vivo) | agente reporta A2S OK | 20–40 s | **90 s** | `FALLIDO` |
| `VERIFICANDO` | activo | agente (A2S OK) | agente reporta `pluginsOk && adminSeeded` | 5–10 s | **30 s** | `FALLIDO` |
| `LISTO` | **terminal ✓** | agente (verificación OK) | — | — | — | — |
| `FALLIDO` | **terminal ✗** | reaper/agente | — | — | — | usuario reintenta (nuevo intent) |
| `CANCELADO` | **terminal** | usuario | — | — | — | — |
| `EXPIRADO` | **terminal** | reaper/usuario | — | — | — | — |

**Turno de cola** (no es un estado del intent sino del `QueueEntry`/`Slot`): cuando un usuario en
cola es promovido, su `claimDeadline = now + claimWindowSec (180 s)`. Si no reclama a tiempo → su
`QueueEntry`/intent va a `EXPIRADO` y se promueve al siguiente.

Presupuestos de duración:
- **ASLEEP (ceiling)**: 150+40+90+30 = **310 s**; típico ~120–150 s → encaja en el perfil **~3 min**.
- **AWAKE (ceiling)**: 40+90+30 = **160 s**; típico ~45–60 s → encaja en el perfil **~45 s**.

Los *deadlines* son techos generosos (la NIC tarda ~15–30 s en modo WoL, arranques fríos varían).
El usuario ve una barra por etapa, no un cronómetro exacto.

### 2.3 Tabla de transiciones (completa)

| # | Desde | Evento / condición | Hacia | Actor que lo dispara | Efecto lateral |
|---|---|---|---|---|---|
| T1 | `SOLICITADO` | hay slot `LIBRE` **y** `Host.state=UP` | `BOOTEANDO` | backend (reserve) | asignar Slot→`PREPARANDO`; encolar cmd `boot_server` |
| T2 | `SOLICITADO` | hay slot `LIBRE` **y** `Host.state∈{DOWN,WAKING}` | `DESPERTANDO` | backend (reserve) | asignar Slot→`PREPARANDO`; **unir al wake singleton** (§4.2); encolar `boot_server` (se ejecuta tras el heartbeat) |
| T3 | `SOLICITADO` | **no** hay slot `LIBRE` (todos `ACTIVO/VACIO/PREPARANDO/RESERVADO_COLA`) | `EN_COLA` | backend (reserve) | crear `QueueEntry(ESPERANDO)` |
| T4 | `DESPERTANDO` | `Host.state=UP` (llegó heartbeat) | `BOOTEANDO` | agente (`/agent/poll`) → backend | el cmd `boot_server` ya está en cola para el agente |
| T5 | `DESPERTANDO` | `now > stateDeadline` (150 s, sin heartbeat) | `FALLIDO` | reaper (`l4d2-tick`) | `errorCode=WAKE_TIMEOUT`; liberar Slot; abortar wake si no queda nadie |
| T6 | `BOOTEANDO` | agente reporta `l4d2@k active` | `INICIANDO` | agente (`/agent/report`) | — |
| T7 | `BOOTEANDO` | `now > stateDeadline` (40 s) | `FALLIDO` | reaper | `errorCode=BOOT_TIMEOUT`; liberar Slot |
| T8 | `INICIANDO` | agente reporta A2S OK (`a2s:true`) | `VERIFICANDO` | agente (`/agent/report`) | encolar/confirmar `reseed_admin` implícito |
| T9 | `INICIANDO` | `now > stateDeadline` (90 s) | `FALLIDO` | reaper | `errorCode=START_TIMEOUT`; liberar Slot |
| T10 | `VERIFICANDO` | agente reporta `pluginsOk && adminSeeded` | `LISTO` | agente (`/agent/report`) | Slot→`ACTIVO`, `ownerSteamId`, `since`; set `connectUrl`; liberar wake singleton si ya no lo usa nadie |
| T11 | `VERIFICANDO` | `adminSeeded=false` reportado, o `now>stateDeadline` (30 s) | `FALLIDO` | agente/reaper | `errorCode=VERIFY_FAILED`; liberar Slot |
| T12 | cualquier no-terminal | `POST /api/reserve`+`{cancel:true}` o `/api/close` del propio usuario | `CANCELADO` | usuario | liberar Slot→`LIBRE`; encolar `close_server` si el proceso ya arrancó; promover cola |
| T13 | `EN_COLA` | es cabeza de cola **y** se liberó un slot | `EN_COLA` (queda) + `QueueEntry→PROMOVIDO` | backend (promoción) | Slot→`RESERVADO_COLA`, `claimSteamId`, `claimDeadline`; avisar por `/api/state` |
| T14 | `EN_COLA (PROMOVIDO)` | el usuario reclama (`/api/reserve` de nuevo) y `Host=UP` | `BOOTEANDO` | usuario | consumir `QueueEntry`; Slot→`PREPARANDO`; encolar `boot_server` |
| T15 | `EN_COLA` | `now > claimDeadline` (promovido y no reclamó) | `EXPIRADO` | reaper | borrar `QueueEntry`; Slot→`LIBRE`; **promover al siguiente** |
| T16 | `EN_COLA` | `POST /api/queue/leave` | `EXPIRADO` | usuario | borrar `QueueEntry`; si estaba `PROMOVIDO`, Slot→`LIBRE` y promover siguiente |
| T17 | `FALLIDO` | `POST /api/reserve` (reintento) | nuevo `SOLICITADO` | usuario | intent nuevo (id nuevo); aplica cooldown/wake-limit |

> `Host=UP` siempre es cierto cuando hay cola (los N están ocupados ⇒ hay servidores corriendo ⇒
> la PC está encendida). Por eso T14 va directo a `BOOTEANDO` y nunca a `DESPERTANDO`.

---

## 3. Perfiles de duración y mapeo al stepper

### 3.1 Solo DOS perfiles (no existe el de ~5 s)

- **`AWAKE` (~45 s)**: `Host.state=UP`. Aun con slot libre, **siempre** se hace un
  `systemctl restart l4d2@k` limpio → `BOOTEANDO → INICIANDO → VERIFICANDO → LISTO`. **No** se
  entrega una instancia ya corriendo "al instante": un slot libre puede tener la instancia detenida
  o vacía/sucia de una partida previa; entregar en ~5 s obligaría a heredar estado ajeno y a
  esquivar el bug de matchmode. Por eso el handover **siempre** cuesta ~45 s. Esto es la
  materialización de "NO existe el perfil de ~5 s".
- **`ASLEEP` (~3 min)**: `Host.state∈{DOWN,WAKING}`. Añade `DESPERTANDO` al frente.

`profile` se fija en `SOLICITADO` según `Host.state` y no cambia después.

### 3.2 Mapeo 1:1 estado → celda del stepper

El stepper NO menciona "PC/infraestructura" (spec §8). Cada estado interno enciende **exactamente
una** celda:

| Estado interno | Celda visible (ASLEEP) | Celda visible (AWAKE) | Etiqueta UI | Copy sugerido |
|---|---|---|---|---|
| `DESPERTANDO` | 1 · Despertando | — (oculta) | "Despertando" | "Encendiendo el servidor…" |
| `BOOTEANDO` | 2 · Iniciando | 1 · Iniciando | "Iniciando" | "Arrancando la instancia…" |
| `INICIANDO` | 2 · Iniciando | 1 · Iniciando | "Iniciando" | "Cargando el mapa…" |
| `VERIFICANDO` | 3 · Verificando | 2 · Verificando | "Verificando" | "Comprobando que todo responde y dándote admin…" |
| `LISTO` | 4 · ¡Listo! | 3 · ¡Listo! | "¡Listo!" | "Tu servidor está arriba" + botón **Conectar** (`connectUrl`) |
| `EN_COLA` | (vista de cola) | (vista de cola) | "En cola" | "Estás #k en la cola…" |
| `FALLIDO` | (vista error) | (vista error) | "Falló" | mensaje honesto + **Reintentar** + "avisar al operador" |
| `CANCELADO` | (cierra stepper) | (cierra stepper) | — | vuelve a la lista |

Stepper AWAKE = 3 celdas (Iniciando · Verificando · Listo). ASLEEP = 4 (con Despertando al frente).
`BOOTEANDO`↔`INICIANDO` comparten celda "Iniciando" (el `copy` puede refinarse por sub-estado).

---

## 4. Convergencia (idempotencia, wake singleton, asignación atómica)

Tres candados independientes, todos con **escrituras condicionales** de DynamoDB (sin locks
externos).

### 4.1 Un intent activo por usuario (idempotencia de `/api/reserve`)

`User.activeIntentId` es el candado. `/api/reserve`:

```text
UpdateItem User
  SET activeIntentId = :newId
  ConditionExpression: attribute_not_exists(activeIntentId) OR activeIntentId = :null
```
- Si **falla** la condición → ya hay un intent activo. Se **lee ese intent y se devuelve tal cual**
  (200, no error). Esto cubre el doble-click y el request duplicado: **convergen al mismo intent**.
- Al llegar a terminal, el intent limpia `User.activeIntentId = null` (para permitir el siguiente).

### 4.2 Wake singleton (dos usuarios encienden la PC "a la vez")

El encendido físico es **uno por host**, no uno por intent. Se coordina en el item `Host`:

```text
UpdateItem Host
  SET state = 'WAKING', wakeStartedAt = :now, lastWolSentAt = :now
  ConditionExpression: state = 'DOWN'
```
- **Gana uno**: invoca la Lambda `wol` (§6) y arranca la secuencia de magic packets.
- **Pierde el resto** (condición falla porque ya está `WAKING`/`UP`): **no** manda otro WoL; su
  intent simplemente entra a `DESPERTANDO` y **observa el mismo `Host`**. Cuando llega el heartbeat,
  `Host.state=UP` y **todos** los intents en `DESPERTANDO` avanzan a `BOOTEANDO` (cada uno con su
  slot). Esta es la "convergencia al mismo intent [de wake]": el proceso de encendido es un
  singleton compartido; las reservas son individuales y cada quien recibe **su** servidor.

### 4.3 Asignación atómica de slot (carrera por el último slot libre)

Dos usuarios que piden con **un solo** slot libre no pueden quedar en el mismo `Slot`:

```text
para cada Slot en estado LIBRE (orden por index):
  try UpdateItem Slot
        SET estado='PREPARANDO', ownerSteamId=:me, intentId=:myIntent, updatedAt=:now
        ConditionExpression: estado = 'LIBRE'
  si éxito -> ese slot es mío; break
  si ConditionalCheckFailed -> alguien lo tomó; probar el siguiente
si no quedó ninguno -> EN_COLA (T3)
```
El perdedor de la carrera prueba el siguiente slot; si no hay, entra en cola. **Nunca** hay dos
dueños en un slot. (La lista de slots libres se relee dentro del intento; el escaneo es de a lo
sumo `N` items, N≈4.)

---

## 5. Cola FIFO

### 5.1 Alta

- La ruta natural: `/api/reserve` cuando `SOLICITADO` no encuentra slot → `EN_COLA` (T3) y crea
  `QueueEntry(ESPERANDO)`. También hay endpoint explícito `/api/queue/join` (idempotente: si ya
  estás en cola devuelve tu posición).
- Orden = `sk` = `POS#<epoch-ms zero-padded 16>#<steamId>`. Cabeza = menor `sk`.
- Un usuario **no** puede estar en cola **y** tener reserva activa a la vez (candado §4.1: si ya
  tiene `activeIntentId`, `/api/reserve` devuelve ese intent; la cola es un estado del propio intent
  `EN_COLA`).

### 5.2 Promoción (se libera un slot)

Disparadores de "se liberó un slot": `T10→` no; los reales son **cierre** (`/api/close`),
**auto-cierre por vacío 15 min** (agente reporta `close_server` hecho), **cancelación**
(`CANCELADO`), **expiración de turno** (T15). En todos, tras poner el `Slot→LIBRE` se ejecuta
`promoverCola()`:

```text
promoverCola(slotLiberado):
  if Config.reservasEnabled == false: return
  head = Query(QUEUE, limit=1, asc)            # cabeza FIFO
  if head is None: Slot.estado = LIBRE; return # nadie espera; slot queda libre
  # reservar el slot para la cabeza
  UpdateItem Slot SET estado='RESERVADO_COLA',
                      claimSteamId=head.steamId,
                      claimDeadline=now+claimWindowSec*1000
  UpdateItem QueueEntry(head) SET estado='PROMOVIDO', slotIndex=slot.index,
                                  claimDeadline=now+claimWindowSec*1000
  # el aviso al usuario es por /api/state (pestaña abierta); email = v2
```
El usuario promovido ve en `/api/state` (y en `/api/queue/status`) `promoted:true` + `claimDeadline`
+ un botón **"Entrar ahora"** → llama `/api/reserve` (o `/api/queue/claim`) → T14 → `BOOTEANDO`
(PC ya UP, perfil AWAKE ~45 s) sobre el `slotIndex` reservado.

### 5.3 Expiración del turno

El reaper (`l4d2-tick`, §12) revisa `QueueEntry` `PROMOVIDO` con `now > claimDeadline`:
- borra el `QueueEntry` (→ `EXPIRADO`),
- `Slot.estado = LIBRE`,
- `promoverCola()` de nuevo (siguiente en la fila).

### 5.4 Interacción con el auto-apagado

- Mientras hay cola, los N slots están ocupados con jugadores ⇒ **sostén #1** ya mantiene la PC
  viva. No hace falta un sostén especial de "cola esperando".
- Cuando se libera un slot y hay `RESERVADO_COLA` con `claimDeadline` en el futuro, ese slot cuenta
  como **sostén** (es un servidor recién vacío `<15 min` **y** hay un turno reservado). El agente lo
  ve en la respuesta de `/agent/poll` (`sostenesNube.colaConReserva > 0`) y **no apaga**.
- Si el turno expira y la cola queda vacía, el slot pasa a `LIBRE`/`VACIO` y sigue la regla normal
  de 15 min. **No** hay "mantener viva la PC indefinidamente por una cola fantasma": la cola solo
  existe con servidores llenos, y un `RESERVADO_COLA` caduca en ≤3 min.

---

## 6. Orquestación del Wake-on-LAN

### 6.1 Magic packet (construcción)

Lambda `wol` (Node.js 20, runtime nativo `dgram`, **sin** dependencias):

```js
import dgram from 'node:dgram';

const MAC = '0AE0AFAF2822';                 // 0A:E0:AF:AF:28:22, sin separadores
function buildMagicPacket(macHex) {
  const mac = Buffer.from(macHex, 'hex');   // 6 bytes
  const parts = [Buffer.alloc(6, 0xff)];    // 6 bytes de 0xFF
  for (let i = 0; i < 16; i++) parts.push(mac); // 16 repeticiones del MAC
  return Buffer.concat(parts);              // 6 + 16*6 = 102 bytes
}
```

### 6.2 A qué IP:puerto

- **Destino**: IP pública de casa, **puerto UDP 9** (discard; convención WoL). El router de casa ya
  tiene el forward `UDP 9 → broadcast/PC` (WoL verificado desde internet, reconocimiento).
- **Resolución de la IP**: preferir **resolver el DDNS** `home.l4d2.ventrax.dev` en cada intento
  (`dns.promises.resolve4`) para tolerar cambios de IP mientras la PC está apagada (S5). *Fallback*:
  `Host.publicIp` (última reportada por el agente). Si ambos fallan → el wake fallará por timeout
  (150 s) → todos los intents `DESPERTANDO → FALLIDO` con `errorCode=WAKE_TIMEOUT` y copy "no pudimos
  encender; avisa al operador".
- Se puede duplicar el envío a **:7 y :9** por robustez (barato). No es necesario broadcast dirigido
  desde la Lambda (lo hace el router).

### 6.3 Reintentos escalonados + verificación

La Lambda `wol` es un **orquestador auto-contenido** (una sola invocación async disparada por
`reserve` cuando gana el candado §4.2). Hace *retries* dentro de la misma invocación, chequeando el
heartbeat entre envíos, para respetar el caveat de la NIC (~15–30 s en entrar en modo WoL):

```text
wol(hostId):
  offsets = [0, 15, 30, 45, 60, 90, 120]  # segundos; los primeros cubren el arranque de la NIC
  for t in offsets:
     esperar hasta t (sleep incremental)
     host = GetItem(Host)
     if host.state == 'UP' and fresco(host.lastHeartbeat): break   # ya despertó
     if host.state == 'DOWN' and host.wakeStartedAt is None: return # wake abortado (T5/nadie espera)
     resolver IP (DDNS -> fallback publicIp)
     enviar magicPacket a IP:9 (y :7)
     UpdateItem Host SET lastWolSentAt = now
  # fin: o despertó (heartbeat) o se agotaron los offsets (~120s); el reaper cerrará por deadline 150s
```
- **Verificación de éxito = heartbeat del agente**: el agente, al arrancar, llama `/agent/poll`
  inmediatamente; el backend hace `Host.state = UP, lastHeartbeat = now`. Eso dispara T4 en todos los
  `DESPERTANDO`. La Lambda `wol` lo detecta en su siguiente iteración y corta el bucle.
- **Doble red de seguridad**: si la Lambda `wol` muere a mitad, el schedule `l4d2-tick` (§12)
  re-manda un magic packet si `Host.state=WAKING` y `now - lastWolSentAt > 30 s`, hasta que el
  `DESPERTANDO` de cada intent llegue a su deadline. Es decir: los retries finos los hace `wol`; la
  malla de 1 min los respalda.

`fresco(ts)` = `now - ts < 30_000` (heartbeat de menos de 30 s).

### 6.4 Wake por `/sourcebans` (operador)

Fuera del flujo de reserva, pero comparte mecanismo: la Lambda que sirve la landing "despertando…"
de `/sourcebans` (dominio infra) valida `jwt.op == true`; si sí, hace **el mismo candado §4.2 +
invoca `wol`** y setea `Host.sourcebansLastUsed = now`. Un visitante sin `op` → 403, **no** enciende
la PC (guardarraíl spec §9). Cada acceso del operador al panel refresca `sourcebansLastUsed`
(sostén #3, ventana 10 min).

---

## 7. Auto-apagado por sostenes (quién decide qué)

El **agente decide** el `poweroff` (spec §14); la nube le entrega los sostenes que solo ella conoce.

Sostenes (la PC sigue viva si **alguno** es cierto):

| # | Sostén | Quién lo evalúa | Fuente |
|---|---|---|---|
| 1 | Algún servidor con jugadores, o vacío hace `<15 min` | **agente** (local, preciso) | A2S + `emptySince` propio |
| 2 | Reserva/encendido en curso (intent activo no-terminal) | **nube** | GSI1 `INTENT_ACTIVE` → `intentsActivos` |
| 2b | Turno de cola reservado (`RESERVADO_COLA` con claim vigente) | **nube** | escaneo Slots → `colaConReserva` |
| 3 | SourceBans usado en los últimos 10 min | **nube** | `Host.sourcebansLastUsed` → `sourcebansReciente` |
| 4 | Sesión SSH activa del operador | **agente** (local) | `who`/`ss` local → `sshActive` |

Flujo:
1. En cada `/agent/poll` la nube responde `sostenesNube = {intentsActivos, colaConReserva,
   sourcebansReciente}` y un `puedeApagar = (todos los sostenes de nube en cero)`.
2. El agente calcula sus locales (1 y 4). Si **ninguno** de {1,2,2b,3,4} aplica → decide `poweroff`.
3. **Anti-carrera**: justo antes de `poweroff`, el agente hace un **último `/agent/poll` fresco**. Si
   `intentsActivos>0` (llegó una reserva en el ínterin) → aborta el apagado. La ventana residual es
   ≤1 intervalo de poll (~10–15 s); si aun así apaga, el WoL lo vuelve a encender (perfil ASLEEP).
   Aceptable para hobby; se documenta.
4. Como cada servidor ya espera sus 15 min de vacío antes de cerrar (sostén #1), "apagar apenas todo
   está cerrado" **no** produce flapping (spec §7).

> Nota: la nube **no** manda un comando `poweroff`; solo informa. El apagado es potestad del agente
> (tiene la foto local exacta de jugadores y SSH). Esto evita que un desfase de la nube apague la PC
> con alguien jugando.

---

## 8. API pública (`/api/*`) — contrato completo

**Transporte**: cada grupo es una **Lambda con Function URL**; CloudFront enruta `/api/*`,
`/auth/steam*`, `/sourcebans*` (spec §5). Function URL auth = `NONE` (validamos **nuestro** JWT
dentro de la Lambda). Todas las respuestas son `application/json; charset=utf-8`.

**Auth**: `Authorization: Bearer <jwt>` (S2). Endpoints marcados 🔓 son públicos (sin token).
`GET /api/state` es público pero **enriquece** si hay token.

**Envelope de éxito**: el objeto pedido directo (sin envoltura extra). **Envelope de error**: §10.

Convenciones: `steamId` = SteamID64 string; timestamps epoch-ms; `slotIndex` 1..N.

### 8.1 `GET /api/state` 🔓 — snapshot de la flota (workhorse del front)

Sin body. Respuesta:
```jsonc
{
  "host": { "state": "UP", "since": 1733600000000 },   // DOWN|WAKING|UP (no exponemos IP)
  "config": { "n": 4, "reservasEnabled": true },
  "slots": [
    { "index":1, "estado":"ACTIVO", "ownerNick":"Bill", "map":"c2m1_highway",
      "players":3, "maxPlayers":8, "since":1733600000000,
      "connect":"steam://connect/home.l4d2.ventrax.dev:6033" },  // connect solo si ACTIVO/VACIO
    { "index":2, "estado":"LIBRE" },
    { "index":3, "estado":"PREPARANDO" },
    { "index":4, "estado":"RESERVADO_COLA" }
  ],
  "queue": { "length": 2 },
  "me": {                                   // presente solo si viene JWT válido
    "steamId":"7656...", "operador":false, "suspendido":false,
    "intent": {                             // null si no tengo intent activo
      "id":"int_abc", "estado":"INICIANDO", "profile":"ASLEEP",
      "slotIndex":1, "stepper":{"total":4,"current":2,"labels":["Despertando","Iniciando","Verificando","¡Listo!"]},
      "connectUrl":null, "errorCode":null
    },
    "queue": { "inQueue":false, "position":null, "promoted":false, "claimDeadline":null },
    "slot": null                            // si soy dueño de un ACTIVO: {index, connect, players, map, emptySince}
  },
  "ts": 1733600000000
}
```
Notas:
- **No** exponemos IP pública ni datos del host más allá de `state`.
- `me.intent.stepper` viene **pre-computado** por el backend (mapeo §3.2) para que el front no
  tenga que conocer los estados internos.
- Este es el único endpoint que el front necesita en régimen normal (lista + mi intent + mi cola).

### 8.2 `POST /api/reserve` — reservar (bajo demanda) / reclamar turno / reintentar

Auth requerida. Body opcional:
```jsonc
{ "cancel": false }   // si true, cancela mi intent activo (equivale a /api/close para intents no LISTO)
```
Lógica (idempotente, §4.1):
1. Validaciones (en orden; primer fallo corta con el error §10):
   - `suspendido` → `403 SUSPENDED`
   - `Config.reservasEnabled=false` → `409 RESERVAS_DISABLED`
   - cooldown: `now - User.lastOpAt < cooldownSec` → `429 COOLDOWN`
   - wake-limit: `User.wakesToday >= maxWakesPerDay` (solo cuenta si va a encender: perfil ASLEEP) → `429 WAKE_LIMIT`
2. Candado idempotencia (§4.1): si ya tengo intent activo **no terminal** → **devuelvo ese intent**
   (200). Si mi intent activo es `EN_COLA (PROMOVIDO)` → esto **reclama el turno** (T14).
3. Si no tengo intent: crear `SOLICITADO` y correr el router (T1/T2/T3) síncrono.
4. Setear `User.lastOpAt=now`; si perfil ASLEEP, `wakesToday++`.

Respuesta 200/201 = el objeto `intent` (mismo shape que `me.intent` de §8.1). Ejemplo recién creado
ASLEEP:
```jsonc
{ "id":"int_abc","estado":"DESPERTANDO","profile":"ASLEEP","slotIndex":1,
  "stepper":{"total":4,"current":1,"labels":["Despertando","Iniciando","Verificando","¡Listo!"]},
  "connectUrl":null,"errorCode":null,"createdAt":1733600000000 }
```
Encolado (T3):
```jsonc
{ "id":"int_q7","estado":"EN_COLA","profile":null,"slotIndex":null,
  "queue":{"position":2,"promoted":false},"connectUrl":null }
```

### 8.3 `GET /api/intent/:id` — estado del intent (poll del stepper)

Auth; solo el dueño (o `op`). Respuesta = objeto `intent` (§8.2). `404 NOT_FOUND` si no existe o no
es mío. *Nota*: el front puede usar `me.intent` de `/api/state` en lugar de este endpoint; se ofrece
por si se quiere una vista dedicada con menos payload.

### 8.4 `POST /api/close` — cerrar mi servidor / cancelar mi intent

Auth. Sin body (cierra lo que tenga el usuario). Efecto:
- Si soy dueño de un Slot `ACTIVO/VACIO` → `Slot→CERRANDO`, encolar `close_server{index}`, limpiar
  `activeIntentId`, `promoverCola()`.
- Si tengo un intent no-terminal (`DESPERTANDO..VERIFICANDO`) → `CANCELADO` (T12), liberar Slot,
  `close_server` si el proceso ya arrancó, `promoverCola()`.
- Si estoy `EN_COLA` → equivale a `/api/queue/leave`.
Respuesta:
```jsonc
{ "ok": true, "closed": { "slotIndex": 1 } }
```
`404 NOT_FOUND` si no tengo nada abierto.

### 8.5 Cola — `join` / `leave` / `status`

- `POST /api/queue/join` (auth): entra a cola (o devuelve posición si ya está). Normalmente
  innecesario (lo hace `reserve`); útil para "anotarme aunque no intente reservar ahora".
  Respuesta: `{ "inQueue":true, "position":3 }`.
- `POST /api/queue/leave` (auth): sale de cola (T16). Si estaba `PROMOVIDO`, libera el slot y promueve
  al siguiente. Respuesta: `{ "ok":true }`.
- `GET /api/queue/status` (auth): `{ "inQueue":true, "position":2, "promoted":false,
  "claimDeadline":null, "queueLength":4 }`. (Misma info que `me.queue` de `/api/state`.)

### 8.6 `GET /api/me` — perfil del usuario

Auth. Respuesta:
```jsonc
{ "steamId":"7656...","nick":"Bill","avatar":"https://...","operador":false,
  "suspendido":false,
  "intent": { ... } | null,          // mi intent activo (o null)
  "queue": { "inQueue":false, "position":null },
  "slot": { "index":1, "connect":"steam://..." } | null,
  "limits": { "wakesToday":2, "maxWakesPerDay":20, "cooldownRemainingSec":0 } }
```

---

## 9. API del agente (`/agent/*`) — Lambda separada, token propio

**Transporte**: el agente hace HTTPS **directo a la Function URL** de la Lambda `agent`
(`https://<id>.lambda-url.us-east-2.on.aws`), **sin** pasar por CloudFront ni por el dominio público
(mantiene el tráfico del agente fuera de `l4d2.ventrax.dev`). Auth: header
`X-Agent-Token: <AGENT_TOKEN>` (S7), comparación en tiempo constante; sin token válido → `401
AGENT_UNAUTHORIZED`. `hostId` fijo `"home"`.

### 9.1 `POST /agent/poll` — heartbeat + obtener comandos (cada ~10–15 s)

Request:
```jsonc
{
  "hostId": "home",
  "publicIp": "1.2.3.4",
  "uptimeSec": 812,
  "sshActive": false,               // sostén #4 (local)
  "acks": [                          // resultado de comandos previos
    { "cmdId":"c1", "status":"done|error", "detail":{"...":"..."} }
  ]
}
```
Efecto backend:
- `Host.state=UP`, `Host.lastHeartbeat=now`, `Host.publicIp`, `Host.sshActive`. Esto dispara **T4**
  en todos los `DESPERTANDO`.
- Procesar `acks` (marcar comandos consumidos; un `error` en `boot_server` puede llevar el intent a
  `FALLIDO`).
Response:
```jsonc
{
  "config": { "n": 4 },
  "sostenesNube": { "intentsActivos": 1, "colaConReserva": 0, "sourcebansReciente": false },
  "puedeApagar": false,              // = (todos los sostenes de nube en cero)
  "commands": [
    { "cmdId":"c1","type":"boot_server","index":1,"ownerSteamId":"7656...","seedAdmin":true },
    { "cmdId":"c2","type":"close_server","index":3 },
    { "cmdId":"c3","type":"reseed_admin","index":2,"ownerSteamId":"7656..." }
  ]
}
```
Comandos (idempotentes por `cmdId`; el agente los deduplica):

| `type` | Params | Acción del agente |
|---|---|---|
| `boot_server` | `index, ownerSteamId, seedAdmin` | `systemctl restart l4d2@index`; esperar `active`; (al responder A2S) sembrar admin del `ownerSteamId` en su puerto; ack `done` con snapshot |
| `close_server` | `index` | `systemctl stop l4d2@index`; limpiar admin por-puerto; ack |
| `reseed_admin` | `index, ownerSteamId` | reescribir admin por-puerto + `sm_reloadadmins` vía RCON `127.0.1.1:port`; ack `adminSeeded` |

> El **poweroff no es un comando**: el agente lo decide (§7). El backend solo entrega
> `sostenesNube`/`puedeApagar`.

### 9.2 `POST /agent/report` — observaciones que avanzan intents y actualizan slots

El agente lo llama **al cambiar** el estado de un servidor observado y, durante un intent activo,
en cada ciclo (para un stepper ágil). Request:
```jsonc
{
  "hostId": "home",
  "servers": [
    { "index":1, "active":true, "a2s":true, "players":3, "bots":4, "maxPlayers":8,
      "map":"c2m1_highway", "emptySince":null, "pluginsOk":true, "adminSeeded":true },
    { "index":3, "active":false, "a2s":false }
  ]
}
```
Efecto backend (por cada `server`, casa con el `Intent` que tiene ese `slotIndex` en estado activo):
- `active=true` y el intent está en `BOOTEANDO` → **T6** `INICIANDO`.
- `a2s=true` y el intent está en `INICIANDO` → **T8** `VERIFICANDO`.
- `pluginsOk=true && adminSeeded=true` y el intent está en `VERIFICANDO` → **T10** `LISTO`
  (Slot→`ACTIVO`, set `connectUrl = steam://connect/home.l4d2.ventrax.dev:<port>`).
- `adminSeeded=false` (reportado explícito) en `VERIFICANDO` → **T11** `FALLIDO`.
- Actualiza siempre `Slot` (players/map/emptySince) para `/api/state`. `players==0 && bots-only` →
  el agente maneja `emptySince` local; el backend solo lo refleja.
Response: `{ "ok": true }` (más `sostenesNube`/`commands` opcionales si se quiere fusionar con poll;
por simplicidad se mantienen separados).

> **Simplificación válida**: `/agent/poll` y `/agent/report` **podrían** ser un solo endpoint
> (el request de report cabe en el de poll). Se dejan separados porque el enunciado los pide y porque
> el heartbeat (poll) debe ser barato y frecuente aunque no haya cambios de servidor. Si se quiere
> menos código, fusionarlos es aceptable.

---

## 10. Shapes de error (consistentes) y rate limiting

**Envelope único** para cualquier fallo:
```jsonc
{ "error": { "code": "COOLDOWN", "message": "Espera 12 s antes de reservar de nuevo.",
             "retryable": true, "retryAfterSec": 12 } }
```
`retryAfterSec` solo en errores de límite. `message` es apto para mostrar al usuario (español).

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `VALIDATION` | body/params inválidos |
| 401 | `UNAUTHENTICATED` | falta/expira el JWT en `/api/*` |
| 401 | `AGENT_UNAUTHORIZED` | token de agente inválido en `/agent/*` |
| 403 | `FORBIDDEN` | recurso ajeno (intent de otro) |
| 403 | `SUSPENDED` | `User.suspendido=true` |
| 404 | `NOT_FOUND` | intent/slot inexistente o no propio |
| 409 | `RESERVAS_DISABLED` | `Config.reservasEnabled=false` |
| 409 | `ALREADY_RESERVED` | (raro; el flujo idempotente normalmente **no** lo lanza — devuelve el intent) |
| 429 | `COOLDOWN` | operaciones demasiado seguidas |
| 429 | `WAKE_LIMIT` | superó `maxWakesPerDay` |
| 429 | `RATE_LIMITED` | demasiados requests (defensa genérica) |
| 500 | `INTERNAL` | error no controlado |

Errores **del intent** (no HTTP; viajan en `intent.errorCode` con estado `FALLIDO`):
`WAKE_TIMEOUT`, `BOOT_TIMEOUT`, `START_TIMEOUT`, `VERIFY_FAILED`, `HOST_UNREACHABLE`. La UI muestra
`errorMsg` + **Reintentar** + "avisar al operador".

**Rate limiting** (hobby, sin WAF): basta el `cooldownSec` por usuario + `maxWakesPerDay`. No se
añade API Gateway ni throttling extra. CORS: `Access-Control-Allow-Origin: https://l4d2.ventrax.dev`
(y el dominio de dev), `Allow-Headers: authorization,content-type`, `Allow-Methods: GET,POST,OPTIONS`.

---

## 11. Polling del front (cadencia adaptativa; evitar el "5 s permanente")

Un único poller a `GET /api/state`. Cadencia según contexto (nunca un intervalo fijo agresivo en
reposo):

| Contexto | Intervalo | Notas |
|---|---|---|
| Viendo la lista, sin intent activo | **15 s** | régimen normal |
| Intent activo (`DESPERTANDO..VERIFICANDO`) o turno `PROMOVIDO` | **4 s** | stepper ágil; **temporal**, vuelve a 15 s en terminal |
| Soy dueño de un `ACTIVO` (ya jugando) | **20 s** | solo refresco de players/map |
| **Pestaña oculta** (`document.hidden`) | **pausa total** | ver abajo |
| Tras error/`HOST` caído | backoff exponencial **10→60 s** (máx) | se resetea al primer 200 |

**Evitar el bug / no disparar 5 s permanentes**:
- **Page Visibility API**: al `visibilitychange`→oculto, **`clearInterval`** (cero requests con la
  pestaña en background). Al volver a visible: **un fetch inmediato** + re-armar el intervalo que
  corresponda. Esto impide que decenas de pestañas dejadas abiertas mantengan un poll de 4 s eterno.
- El intervalo de **4 s existe solo mientras el intent NO es terminal**. En `LISTO/FALLIDO/CANCELADO`
  el poller vuelve a 15 s (o 20 s si quedé dueño). **Nunca** hay un 4 s de reposo.
- **Un solo timer** en toda la app (no un `setInterval` por componente). Preferir `setTimeout`
  recursivo re-agendado tras cada respuesta (evita solapamiento si el backend tarda).
- El front **no** hace polling al `/api/intent/:id` en paralelo; usa `me.intent` de `/api/state`.
- No hay websockets/SSE (over-engineering para este tamaño): el polling adaptativo basta.

---

## 12. EventBridge Scheduler — un solo tick

Un **único** schedule recurrente cubre todo lo periódico (mínimo `rate` = 1 min; suficiente: los
deadlines son de decenas de segundos a minutos, no necesitamos sub-minuto).

`l4d2-tick` — `ScheduleExpression: rate(1 minute)` → invoca la Lambda `tick`. En cada corrida:

1. **Reaper de intents colgados**: `Query GSI1(INTENT_ACTIVE)` con `GSI1SK < now` (deadline
   vencido). Cada uno → `FALLIDO` con el `errorCode` del estado (`WAKE_TIMEOUT/BOOT_TIMEOUT/…`),
   liberar Slot (`→LIBRE`), limpiar `User.activeIntentId`, `promoverCola()`.
2. **Expiración de turnos de cola**: escanear Slots `RESERVADO_COLA` con `claimDeadline < now` →
   `QueueEntry PROMOVIDO` correspondiente a `EXPIRADO`, Slot→`LIBRE`, `promoverCola()` (T15).
3. **Malla de seguridad WoL**: si `Host.state=WAKING` y `now - Host.lastWolSentAt > 30 s` y hay
   `DESPERTANDO` vivos → re-invocar `wol` (o mandar el packet inline). Si ya no queda ningún
   `DESPERTANDO` → abortar wake (`Host` puede volver a `DOWN` si tampoco hay otros sostenes; en
   la práctica el agente ya reportará y ajustará).
4. **Higiene**: borrar intents terminales viejos (TTL de DynamoDB ya lo hace; ver nota), y
   normalizar `Host.state=DOWN` si `now - lastHeartbeat > 90 s` (el agente dejó de reportar ⇒ la PC
   se apagó).

**Costo/idle**: si no hay intents activos ni cola ni wake, el tick es 1 `Query` al GSI (vacío) +
1 `GetItem(Host)` y termina. 43.200 invocaciones/mes → dentro de free tier holgado. No se necesitan
schedules one-shot por intent (más items que gestionar); el barrido de 1 min es suficiente y más
simple. **TTL de DynamoDB**: poner `ttl` (epoch-s) en intents terminales y en `QueueEntry`
consumidos para que se auto-borren sin trabajo del tick.

---

## 13. Lambdas, Function URLs y routing (referencia para infra-cdk)

| Lambda (nombre lógico) | Ruta CloudFront | Function URL auth | Responsabilidad |
|---|---|---|---|
| `api` | `/api/*` | NONE (JWT propio) | `state, reserve, intent/:id, close, queue/*, me` (router interno por método+path) |
| `authSteam` | `/auth/steam*` | NONE | login Steam OpenID + emisión de JWT (dominio auth-steam) |
| `agent` | — (Function URL directa) | NONE (X-Agent-Token) | `/agent/poll`, `/agent/report` |
| `wol` | — (invoke async) | — | orquestador WoL (§6); la invoca `api` al ganar el candado wake |
| `tick` | — (target del schedule) | — | reaper + expiración + malla WoL (§12) |
| `sourcebansWake` | `/sourcebans` landing | NONE (JWT propio, exige `op`) | wake-on-uso del operador (§6.4); el proxy real a la PC lo hace CloudFront con origen DDNS |

- **CloudFront**: `/api/*`→`api` FURL, `/auth/steam*`→`authSteam` FURL, `/sourcebans*`→origen DDNS
  de casa (con `sourcebansWake` interceptando la landing de "despertando" cuando `Host` está DOWN),
  `/*`→S3 (SPA). El agente **no** usa CloudFront.
- **Permisos IAM** (mínimos): `api` → RW a la tabla + `lambda:InvokeFunction` sobre `wol`.
  `agent` → RW a la tabla. `wol` → RW `Host` + red saliente UDP (no VPC). `tick` → RW tabla +
  invoke `wol`. Sin VPC/NAT en ninguna (§ spec 13).
- **Región**: `us-east-2` (cuenta 211125402452). El cert ACM de CloudFront va en `us-east-1`
  (dependencia infra, fuera de este dominio).

---

## 14. Secuencias completas (ASCII)

### 14.1 Reserva con PC dormida (perfil ASLEEP, ~3 min)

```
Jugador   SPA          api (Lambda)     DynamoDB        wol         Agente(PC)
  │  reservar │             │               │            │             (apagada)
  │──────────►│ POST /reserve│              │            │
  │           │────────────►│ cond User.activeIntent      │
  │           │             │──── put Intent(SOLICITADO) ►│
  │           │             │ router: slot libre, Host=DOWN
  │           │             │ cond Host DOWN→WAKING (gana) │
  │           │             │──── invoke async ──────────►│ wol
  │           │             │ Intent→DESPERTANDO          │  envía magic packet :9
  │           │◄────────────│ 200 {estado:DESPERTANDO}    │  (t=0,15,30…)  ─ ─ ─► (WoL)
  │◄──────────│ stepper[1]  │                             │
  │  poll /state (4s)…      │                             │           …PC arranca…
  │           │             │                    Agente arranca, POST /agent/poll
  │           │             │◄────────────────────────────────────────┤ heartbeat
  │           │             │ Host→UP  ⇒ T4: DESPERTANDO→BOOTEANDO     │
  │           │             │ resp: commands=[boot_server 1]           │──► systemctl restart l4d2@1
  │           │             │◄── /agent/report {active:true} ──────────┤
  │           │             │ T6: BOOTEANDO→INICIANDO                   │
  │           │             │◄── /agent/report {a2s:true} ─────────────┤ (mapa cargado)
  │           │             │ T8: INICIANDO→VERIFICANDO                 │  siembra admin (RCON)
  │           │             │◄── /agent/report {pluginsOk,adminSeeded} ┤
  │           │             │ T10: →LISTO, connectUrl, Slot ACTIVO      │
  │  poll /state → me.intent.estado=LISTO, connectUrl                   │
  │◄──────────│ botón Conectar (steam://connect/home…:6033)             │
```

### 14.2 Reserva con PC despierta (perfil AWAKE, ~45 s)

Igual que 14.1 pero se **omite** DESPERTANDO/WoL: `SOLICITADO`→`BOOTEANDO` directo (T1); el
`boot_server` sale en el siguiente `/agent/poll` (≤10–15 s), luego `INICIANDO`→`VERIFICANDO`→`LISTO`.

### 14.3 Cola: los N ocupados, luego se libera uno

```
UserB reservar → SOLICITADO → (sin slot) → EN_COLA (QueueEntry pos#2)
   … juega gente en los 4 …
UserA POST /api/close (slot 2) → Slot2 CERRANDO → close_server → promoverCola():
   cabeza=UserB → Slot2 RESERVADO_COLA (claimDeadline=+180s), QueueEntry(UserB)=PROMOVIDO
UserB ve en /api/state: promoted:true, claimDeadline → botón "Entrar ahora"
UserB POST /api/reserve (reclama, T14) → BOOTEANDO sobre slot 2 (Host UP, ~45s) → … → LISTO
   (si UserB no reclama en 180s → tick: EXPIRADO, Slot2 LIBRE, promoverCola() al siguiente)
```

---

## 15. Qué NO hacer (anti-sobreingeniería)

- **No** WebSockets/SSE/AppSync: el polling adaptativo (§11) sobra para decenas de usuarios.
- **No** API Gateway: Function URLs + CloudFront bastan (spec §13). Sin VPC/NAT.
- **No** Step Functions para el intent: la máquina de estados vive en items de DynamoDB + el tick de
  1 min. Step Functions añadiría costo/complejidad sin beneficio a esta escala.
- **No** múltiples schedules one-shot por intent/turno: un solo `l4d2-tick` de 1 min + TTL de
  DynamoDB. Los deadlines finos (heartbeat) los resuelve el propio `wol` en su invocación.
- **No** comando `poweroff` desde la nube: el agente decide (evita apagar con jugadores por desfase).
- **No** perfil "instantáneo ~5 s": el handover **siempre** reinicia la instancia (~45 s) para
  entregar un servidor limpio (§3.1).
- **No** cola persistente que mantenga viva la PC "por si acaso": la cola solo existe con los N
  llenos; un turno reservado caduca en ≤3 min (§5.4).
- **No** exponer IP pública del host en la API pública (solo `Host.state`).

---

## 16. Checklist de implementación (resumen accionable)

- [ ] Tabla `l4d2-panel` con GSI1 `INTENT_ACTIVE` (dominio datos) + TTL en intents/queue terminales.
- [ ] Lambda `api` con router: `state, reserve, intent/:id, close, queue/{join,leave,status}, me`.
- [ ] Lambda `agent` (`/agent/poll`, `/agent/report`) con `X-Agent-Token`.
- [ ] Lambda `wol` (dgram, magic packet 102 B a DDNS/publicIp:9, retries 0–120 s, corta en heartbeat).
- [ ] Lambda `tick` (reaper intents, expiración turnos, malla WoL, normalización Host) + schedule
      `rate(1 minute)`.
- [ ] Candados condicionales: `User.activeIntentId` (idempotencia), `Host state DOWN→WAKING`
      (wake singleton), `Slot estado LIBRE→PREPARANDO` (asignación atómica).
- [ ] Mapeo estado→stepper pre-computado en el backend (§3.2).
- [ ] Front: poller único adaptativo con Page Visibility (§11).
- [ ] Contrato con el agente: comandos `boot_server/close_server/reseed_admin`, reporte
      `active/a2s/pluginsOk/adminSeeded`, decisión local de `poweroff` con `sostenesNube`.
- [ ] Errores con envelope `{error:{code,message,retryable}}` y códigos §10.

---

## 17. Preguntas abiertas / a confirmar con dominios vecinos

1. **DDNS**: ¿lo actualiza el router (ideal, S5) o solo la PC? Si solo la PC, el WoL con IP cambiada
   mientras está apagada fallará; mitigación en §6.2 (fallback a `Host.publicIp`).
2. **`adminSeeded`**: depende del plugin `panel_admin.smx` por-puerto (S4, dominio local). Aquí solo
   consumo el booleano; confirmar que el agente puede reportarlo de forma fiable vía RCON.
3. **Reasignación de instancia en promoción de cola**: asumo `systemctl restart` limpio del slot
   reservado (perfil AWAKE). Confirmar que el bug de matchmode no obliga a un `stop` completo antes.
4. **`maxWakesPerDay`/`cooldownSec`**: valores iniciales (20 / 20 s) a calibrar con uso real.
5. **JWT**: algoritmo y TTL los fija auth-steam; aquí solo verifico firma+exp (clave pública/secreto
   compartido con la Lambda `api`).
