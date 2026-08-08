# L4D2 Panel — Diseño técnico del AGENTE (PC de casa)

> Dominio: **agente local**. Este documento especifica el proceso que corre en la PC de casa de
> Ventrax (Ubuntu Server, normalmente APAGADA), hace de plano de control entre la flota L4D2 y la
> nube AWS, y aplica la lógica de auto-apagado. Es fuente de verdad para implementar sin re-diseñar.
>
> Fuentes: `docs/especificaciones-v1.md`, repo Ansible `l4d2-fleet` (leído verbatim), y el
> RECONOCIMIENTO FACTUAL. Ajustado a contexto **hobby**: pocos servidores, decenas de usuarios,
> costo ~$0. Donde algo sobra, se dice explícitamente.

---

## 0. Rol del agente en una frase

El agente **no abre puertos entrantes**. Cada ~12 s hace un **POST HTTPS saliente** a la nube
(`/agent/poll`) que combina *heartbeat + estado de los slots + señales de sostén + IP pública*, y
recibe **comandos** (levantar/cerrar servidor, apagar). Los ejecuta de forma **idempotente**, los
**confirma** (`/agent/report`), verifica salud vía **A2S + RCON loopback**, siembra el **admin
por-servidor**, y **apaga la PC** cuando no queda ningún sostén — incluso sin internet.

```
   AWS (nube, siempre viva)                         PC de casa (normalmente apagada)
 ┌──────────────────────────┐   HTTPS saliente    ┌───────────────────────────────────────┐
 │ CloudFront /agent/*       │◄───── POST /poll ───│  l4d2-agent.service (Python, stdlib)    │
 │   └─ Lambda "agente"      │──── commands ──────►│   ├─ scrape 127.0.0.1:9101 (exporter)   │
 │        └─ DynamoDB        │◄──── POST /report ──│   ├─ RCON → 127.0.1.1:<port>            │
 │ Lambda WoL (UDP magic)    │                     │   ├─ sudo systemctl start/stop l4d2@k   │
 └──────────────────────────┘                     │   ├─ escribe admins-<port>.txt          │
        ▲  magic packet UDP a IP pública           │   └─ sudo systemctl poweroff            │
        └────────────────────────────────── WoL ───┤  flota l4d2@1..N + panel_admin.smx       │
                                                    └───────────────────────────────────────┘
```

Reparto de responsabilidades (importante, evita solapes):

| Decisión | Dueño | Por qué |
|---|---|---|
| Propiedad de slot, cola, intents, N | **Nube (DynamoDB)** | Requiere estado global y persistente |
| Emitir WoL (magic packet) | **Nube (Lambda WoL)** | El agente no está vivo cuando la PC duerme |
| Actualizar DDNS (Route53) | **Nube (Lambda)** | Mantiene credenciales AWS fuera de la PC de casa |
| Arrancar/parar `l4d2@k`, sembrar admin, verificar | **Agente** | Acción local |
| Cerrar servidor vacío tras 15 min | **Agente (política local)** | Debe funcionar aunque la nube esté caída; es seguridad de energía |
| `poweroff` por ausencia de sostenes | **Agente (política local)** | Todos los sostenes son verificables localmente; funciona offline |
| Watchdog churn matchmode (`sm plugins refresh`) | **Agente** | Acción local sobre servidor vacío |

---

## 1. Lenguaje, distribución, usuario, hardening

### 1.1 Lenguaje
- **Python 3, solo stdlib** (`urllib.request`, `ssl`, `json`, `socket`, `subprocess`, `struct`,
  `hmac`, `hashlib`, `logging`). Mismo estilo que `l4d2_exporter.py`. **Sin `pip`, sin venv, sin
  dependencias externas** → instalación trivial por Ansible y nada que actualizar. `requests` sería
  cómodo pero no justifica una dependencia en una caja hobby.
- Un solo archivo `agent.py` (~500-700 líneas). Si crece, dividir en `agent/{__main__,poll,rcon,
  state,sustains,commands}.py`, pero arrancar monolítico.

### 1.2 Distribución (repo privado → checkout local)
El repo `l4d2-fleet` es privado, así que **Ansible copia el agente desde el checkout local** (no se
clona en el host). Se **extiende el rol `l4d2_fleet`** existente:

```
roles/l4d2_fleet/
├── files/agent/agent.py                 # el agente (copy)
├── files/agent/fleetctl                 # wrapper de sudo (copy, 0755 root)
├── files/custom-plugins/scripting/panel_admin.sp   # plugin admin por-servidor (nuevo)
├── files/custom-plugins/panel_admin.smx            # compilado (nuevo)
├── templates/l4d2-agent.service.j2      # unit del agente
├── templates/agent.conf.j2              # config no-secreta
├── templates/l4d2-agent.sudoers.j2      # sudoers scoped (por-unidad, 1..N)
└── tasks/agent.yml                      # nuevo, importado desde tasks/main.yml (gate: with_agent)
```

`tasks/main.yml` añade al final (después de `fleet.yml` y `monitoring.yml`):

```yaml
- name: Deploy the panel agent
  ansible.builtin.import_tasks: agent.yml
  when: with_agent | default(true) | bool
```

**El token NO va en el repo** (§3): se coloca por `ansible-vault` o a mano en `/etc/l4d2-fleet/agent.token`.

### 1.3 Cambio de modelo obligatorio en la flota (dependencia)
Hoy `fleet.yml` hace `systemctl enable --now l4d2@{1..N}` (todos arrancan al boot). **En la caja del
panel esto NO debe pasar**: la PC bootea **ociosa** y los servidores se levantan **bajo demanda**
por `START_SERVER`. Cambiar la tarea "Start and enable the servers" para que, cuando
`with_agent | bool`, los units queden **`enabled: false, state: stopped`** (o simplemente no se
toquen). El agente es el único que los arranca/para. Sin este cambio, la PC nunca quedaría ociosa.

### 1.4 Usuario del servicio
Usuario dedicado **`l4d2agent`** (no-root, `--system`, sin shell: `/usr/sbin/nologin`, home
`/var/lib/l4d2-panel`), **miembro del grupo `steam`**. Con eso:

| Necesita | Cómo lo obtiene sin ser root |
|---|---|
| Leer `RCON_PASSWORD` de `/etc/l4d2-fleet/fleet.env` (`0640 steam:steam`) | grupo `steam` |
| Escribir `admins-<port>.txt` en el árbol del juego | dir dedicado `.../data/panel/` en modo `2775 steam:steam` (setgid) |
| Consultar A2S/estado | scrape a `127.0.0.1:9101` (exporter) — sin privilegio |
| Hablar RCON | TCP a `127.0.1.1:<port>` (loopback) — sin privilegio |
| `systemctl start/stop/restart l4d2@k` | **sudo scoped** (§11) |
| `systemctl poweroff` | **sudo scoped** (§11) |
| Detectar sesiones SSH | `pgrep`/`ss` — sin privilegio (salvo `hidepid`, ver §6) |

Alternativa más simple pero con más blast radius: correr el agente como `steam`. Se descarta:
`l4d2agent` aísla el proceso del identity del juego con costo casi nulo.

### 1.5 systemd unit del agente (`l4d2-agent.service`)

```ini
[Unit]
Description=L4D2 Panel agent (outbound control-plane + auto-poweroff)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=l4d2agent
Group=l4d2agent
SupplementaryGroups=steam
ExecStart=/usr/bin/python3 /opt/l4d2-fleet/agent/agent.py
Restart=always
RestartSec=5
StartLimitIntervalSec=0          # nunca dejar de reintentar (es el plano de control)
RuntimeDirectory=l4d2-panel      # crea /run/l4d2-panel (0750)
StateDirectory=l4d2-panel        # crea /var/lib/l4d2-panel (0750)

# Hardening compatible con sudo (sudo es SUID → NoNewPrivileges debe ser false):
NoNewPrivileges=false
ProtectSystem=full               # /usr, /boot, /etc de solo lectura
ProtectHome=false                # necesita escribir .../data/panel bajo /home/steam
ReadWritePaths=/home/steam/l4d2/left4dead2/addons/sourcemod/data/panel
PrivateTmp=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictRealtime=true
```

> **Nota de hardening:** el agente usa `sudo` (SUID) para `systemctl`/`poweroff`, así que
> `NoNewPrivileges=true` y `MemoryDenyWriteExecute`/`SystemCallFilter` agresivos **romperían sudo**
> y quedan fuera. Si se quiere el sandbox máximo, la alternativa es **polkit** (reglas `.rules` que
> autoricen `org.freedesktop.systemd1.manage-units` para `l4d2@*.service` y
> `org.freedesktop.login1.power-off` a `l4d2agent`), lo que permite quitar sudo y activar
> `NoNewPrivileges=true` + `ProtectSystem=strict`. Para hobby, **sudo + wrapper (§11) es suficiente**
> y más fácil de razonar; polkit queda anotado como upgrade opcional, no requerido.

---

## 2. Bucle principal y protocolo

### 2.1 Ciclo
```
cargar config + token + journal
loop:
    now = monotonic()
    estado = recolectar_estado()          # exporter :9101 (+ A2S fallback), sostenes, IP, boot_id
    aplicar_politica_local(estado)         # empty-close 15min, watchdog churn, decisión poweroff
    resp = POST /agent/poll  {estado, acks}    # con backoff si falla
    if resp ok:
        server_count = resp.server_count   # N autoritativo de la nube
        inhibit      = resp.shutdown_inhibit
        for cmd in resp.commands:          # ordenados; dedup por cmd_id (journal)
            ejecutar_idempotente(cmd)       # reporta stage vía /agent/report en transiciones
    dormir(poll_interval ± jitter)         # 12s base; backoff si offline
```

- **Intervalo:** `POLL_INTERVAL=12s` (rango 10-15 de la spec) + jitter ±2s. La nube puede
  sobre-escribirlo con `poll_interval_s` en la respuesta (p. ej. bajarlo a 4s mientras hay un intent
  en curso para un stepper más ágil, subirlo a 20s cuando todo está ocioso pero encendido).
- `recolectar_estado` es barato (un GET local a `:9101` + `stat`/`pgrep`). No bloquea el bucle.
- La **política local** corre **cada ciclo, tenga o no internet**. El POST puede fallar y aun así la
  PC se cierra sola correctamente.

### 2.2 `POST /agent/poll` — request

```jsonc
{
  "agent_version": "1.0.0",
  "host_id": "l4d2-home",              // identifica el Host item en DynamoDB
  "ts": 1712345678,                     // epoch s (reloj de pared)
  "seq": 48213,                         // monotónico local, detecta reordenamiento/reinicio
  "boot_id": "3f2b...c9",               // /proc/sys/kernel/random/boot_id → detecta reboot
  "uptime_s": 1834,
  "public_ip": "181.55.12.9",           // best-effort self-detect (§9); la nube manda con XFF
  "server_count_provisioned": 4,        // techo real de units (sudoers/Ansible)
  "sustains": {                          // ver §6; refleja lo que el agente ve localmente
    "servers_active": true,
    "intent_active": false,
    "sourcebans_recent": false,
    "ssh_active": true,
    "boot_grace": false
  },
  "poweroff_intent": false,             // true si el agente YA decidió apagar este ciclo
  "slots": [
    { "k":1, "port":6033, "service_up":true, "a2s_up":true,
      "players":7, "bots":4, "humans":3, "max":8, "map":"c2m1_highway",
      "owner_steamid":"76561198000000000", "admin_seeded":true,
      "empty_since": null, "health":"ok" },
    { "k":2, "port":6034, "service_up":false, "a2s_up":false,
      "players":0, "bots":0, "humans":0, "max":0, "map":"",
      "owner_steamid":null, "admin_seeded":false,
      "empty_since": null, "health":"stopped" }
  ],
  "acks": [                              // últimos M comandos terminados (at-least-once)
    { "cmd_id":"c-9f3a", "type":"START_SERVER", "status":"done" }
  ]
}
```

### 2.3 `POST /agent/poll` — response

```jsonc
{
  "server_time": 1712345679,
  "poll_interval_s": 12,
  "server_count": 4,                    // N autoritativo (Config item); techo lógico de slots
  "shutdown_inhibit": false,            // true → la nube pide NO apagar (p. ej. cola con gente)
  "observed_ip": "181.55.12.9",         // IP origen que vio CloudFront (XFF) → §9
  "token_rotation": null,               // o "grace" si hay rotación en curso (informativo)
  "commands": [
    { "cmd_id":"c-9f3a", "type":"START_SERVER", "k":2,
      "admin_steamid":"76561198000000000",
      "issued_at":1712345670, "deadline":1712345730 },   // ignorar si now > deadline
    { "cmd_id":"c-a01b", "type":"STOP_SERVER", "k":1,
      "issued_at":1712345671, "deadline":1712345731 }
  ]
}
```

### 2.4 `POST /agent/report` — request (adelanta el stepper entre polls)
Se dispara **inmediatamente en cada transición de stage** de un comando (para que el stepper de la
SPA no espere al siguiente poll). Es idempotente y re-enviable.

```jsonc
{
  "host_id":"l4d2-home", "ts":1712345690, "seq":48214,
  "results":[
    { "cmd_id":"c-9f3a", "type":"START_SERVER", "k":2,
      "status":"in_progress", "stage":"STARTING", "detail":"unit arrancado, esperando A2S" },
    { "cmd_id":"c-9f3a", "type":"START_SERVER", "k":2,
      "status":"done", "stage":"READY", "verified":true,
      "connect":"steam://connect/181.55.12.9:6034", "map":"c1m1_hotel",
      "plugins_ok":true }
  ]
}
```
Response: `{ "ack": ["c-9f3a"] }`. Si la nube no acka, el agente reincluye el resultado en `acks`
del siguiente `/poll` (§10). Estados de `status`: `received` · `in_progress` · `done` · `failed` ·
`expired` · `noop` (ya estaba en el estado deseado).

**Stages canónicos de START** (alineados al stepper de la spec §8): `STARTING` → `SEEDING_ADMIN`
→ `VERIFYING` → `READY` (o `FAILED`). El texto que ve el jugador lo mapea la SPA
(DESPERTANDO/INICIANDO/VERIFICANDO/LISTO); el agente solo emite el stage técnico.

### 2.5 Autenticación de la llamada
- Header `Authorization: Bearer <device_token>` en **todo** POST. TLS obligatorio (CloudFront).
- **Firma HMAC (upgrade barato recomendado):** header
  `X-Agent-Signature: sha256=<hmac(token, ts + "." + body)>` y `X-Agent-Ts: <ts>`. La Lambda
  rechaza `|now - ts| > 300s` (anti-replay) y valida el HMAC. Con esto, aunque el token se filtre en
  un log de CloudFront, no basta un cuerpo capturado para replay fuera de la ventana. Es ~10 líneas;
  si se omite, el bearer sobre TLS es el mínimo aceptable.
- `Content-Type: application/json`. Timeout de socket 8 s por request.

---

## 3. Token de dispositivo

### 3.1 Qué es y dónde vive
- Secreto aleatorio de 256 bits: `openssl rand -hex 32` → 64 hex chars.
- Archivo **`/etc/l4d2-fleet/agent.token`**, permisos **`0400 l4d2agent:l4d2agent`**.
- **Nunca** por CLI ni en variables de entorno de otros units (evita fuga por `ps`/`/proc/*/environ`).
  El agente lo lee al arrancar (y lo **relee** ante 401/403 repetidos, por si el operador lo rotó).
- La nube guarda su **hash** (o el valor) en el `Host` item de DynamoDB (`token_hash`,
  `token_hash_next`), asociado a `host_id`. Un token ↔ un host.

### 3.2 Generación
Operador en la caja:
```bash
umask 077
openssl rand -hex 32 | sudo tee /etc/l4d2-fleet/agent.token >/dev/null
sudo chown l4d2agent:l4d2agent /etc/l4d2-fleet/agent.token
sudo chmod 400 /etc/l4d2-fleet/agent.token
```
Y registra su hash en el `Host` item (script del dominio nube). En Ansible se entrega vía
`ansible-vault` (variable `agent_token`) o se deja el paso manual — **no** en el repo en claro.

### 3.3 Rotación (ventana de doble validez)
1. Nube: poner el **nuevo** `token_hash_next` en el `Host` item (ahora acepta viejo **y** nuevo).
2. Caja: reemplazar `/etc/l4d2-fleet/agent.token` con el nuevo valor + `systemctl restart l4d2-agent`
   (o simplemente esperar: el agente relee ante el primer 401).
3. Nube: promover `next` → `token_hash` y borrar el viejo. Ventana cerrada.

Sin downtime; el agente reintenta con backoff durante el swap.

### 3.4 Modelo de amenaza (qué gana un atacante con el token)
**Clave: el token autentica agente→nube, NO nube→agente. Un token robado deja MENTIR a la nube, no
CONTROLAR la PC.** No otorga shell, ni RCON, ni sudo, ni WoL (todo eso es local o vive en la nube y
está detrás de la lógica de reserva).

| Con el token, un atacante puede | Daño real | Mitigación |
|---|---|---|
| Suplantar el heartbeat / falsear el estado de slots | La nube cree que hay/no hay jugadores; puede liberar slots mal o mostrar estado falso en la SPA | TLS + `0400` + HMAC anti-replay + rate-limit en la Lambda; el estado es de bajo valor (juego casual) |
| Ackear/adelantar resultados de comandos | Marca un START como listo sin estarlo → jugador ve "LISTO" y no conecta | La SPA/nube puede re-verificar por A2S propio antes de dar el connect; reintento honesto |
| Aprender la IP pública de casa y el estado | Info de reconocimiento | La IP ya es alcanzable por WoL/`/sourcebans`; bajo valor |
| **NO** puede: encender la PC, apagar la PC, correr comandos en la PC, banear, leer la MySQL | — | El token no es un canal de comando hacia la PC |

Detección de anomalía barata en la nube (opcional): si llega un `/poll` con `host_id` conocido desde
una IP que **no** coincide con la IP de origen esperada mientras el WoL no fue disparado, marcar y
descartar. No crítico para v1.

---

## 4. Comandos

Todos idempotentes, identificados por `cmd_id`, con `deadline`. El agente **descarta** comandos con
`now > deadline` y responde `status:"expired"`. Journal de dedup en §10.

| Comando | Args | Efecto | Idempotencia |
|---|---|---|---|
| `START_SERVER` | `k`, `admin_steamid` | Levanta `l4d2@k`, siembra admin, verifica, entrega connect | Si ya activo+A2S up+admin sembrado → `noop` READY |
| `STOP_SERVER` | `k` | Para `l4d2@k` (SIGINT vía systemctl), borra `admins-<port>.txt` | Si ya parado y archivo ausente → `noop` |
| `RESTART_SERVER` | `k`, `admin_steamid?` | `systemctl restart`, re-siembra, re-verifica (recuperación de server colgado) | Converge al estado sano |
| `RESEED_ADMIN` | `k`, `admin_steamid` | Reescribe `admins-<port>.txt` + RCON `panel_admin_reload` (cambio de dueño en slot ya vivo) | Reescribe = mismo resultado |
| `CLEAR_ADMIN` | `k` | Borra `admins-<port>.txt` + RCON `panel_admin_reload` | Idempotente |
| `REFRESH_PLUGINS` | `k` | RCON `sm plugins refresh` (watchdog manual, §8), solo si `humans==0` | Seguro repetir |
| `POWEROFF` | `force?` | Re-chequea sostenes (salvo `force`), para units, `sudo systemctl poweroff` | Si ya apagándose → `noop` |

No se incluyen `KICK`/`CHANGE_MAP`/`BAN` como comandos del agente: el **reservador ya es admin
in-game** (kick/mapa/match), y el ban es solo LAC/operador vía SourceBans. Meterlos sería
sobre-ingeniería. (Si el futuro panel de operador los quiere, se añaden como comandos nuevos con el
mismo patrón — el agente ya tiene RCON.)

### 4.1 START_SERVER — pseudocódigo

```python
def cmd_start(k, admin_steamid, deadline):
    port = PORT_BASE + k
    if k > server_count_provisioned:        # sudoers no lo permite
        return fail(k, "slot fuera del techo provisionado")

    # 1) Asegurar unidad arriba (idempotente)
    if not unit_active(k):
        report(cmd, "in_progress", "STARTING")
        sudo_fleetctl("start", k)           # § 11
    # 2) Sembrar admin ANTES de que el jugador conecte (§5). El plugin lo aplica al conectar.
    report(cmd, "in_progress", "SEEDING_ADMIN")
    write_admin_file(port, admin_steamid, RESERVER_FLAGS)   # atómico: tmp + rename
    if unit_was_already_up:                  # server reciclado con gente/o ya vivo
        rcon(port, "panel_admin_reload")     # aplica a conectados; en arranque fresco no hace falta

    # 3) Verificar salud con warmup (§7)
    report(cmd, "in_progress", "VERIFYING")
    ok, info = verify_health(k, warmup_s=45)
    if not ok:
        # un intento de recuperación antes de rendirse
        rcon(port, "sm plugins refresh"); sleep(3)
        ok, info = verify_health(k, warmup_s=10)
    if not ok:
        return fail(k, "no verificó A2S/plugins", stage="FAILED")

    connect = f"steam://connect/{public_ip}:{port}"
    mark_owner(k, admin_steamid)
    return done(cmd, stage="READY", connect=connect, map=info.map, plugins_ok=True)
```

### 4.2 STOP_SERVER — pseudocódigo
```python
def cmd_stop(k):
    port = PORT_BASE + k
    if unit_active(k):
        sudo_fleetctl("stop", k)             # SIGINT → srcds sale limpio (KillSignal=SIGINT en el unit)
    delete_admin_file(port)                   # limpieza del admin por-servidor
    clear_owner(k); clear_empty_since(k)
    return done(cmd, stage="STOPPED")
```

---

## 5. Admin por-servidor (plugin `panel_admin.sp`)

### 5.1 Problema
`admins_simple.ini` es **global** (install compartido `/home/steam/l4d2`; las N units usan el mismo
árbol). Sembrar al reservador ahí lo haría admin en **todos** los servidores. Hace falta admin
**solo en su puerto**, que se limpie al reciclar.

### 5.2 Mecanismo
- El **agente** escribe un archivo **por-puerto**:
  `…/addons/sourcemod/data/panel/admins-<port>.txt` (p. ej. `admins-6034.txt`).
- Un **plugin nuevo `panel_admin.smx`** corre en cada instancia, obtiene **su** puerto con
  `FindConVar("hostport")` (mismo mecanismo que `chat_logger` usa hoy, verificado en la flota),
  lee **su** `admins-<port>.txt`, y **concede flags de admin en runtime** vía la Admin Cache API
  (sin tocar `admins_simple.ini`, sin ban).
- Se limpia al cerrar (el archivo se borra en STOP; y de todos modos el proceso muere).
- **Se agrega a la lista de reservados del unloader parcheado** para sobrevivir el churn de matchmode.

**Formato del archivo** (lo escribe el agente; una línea por admin, normalmente una sola):
```
# admins-6034.txt — gestionado por l4d2-agent. No editar a mano.
STEAM_1:0:20000000 bcfgij
```
El agente **convierte SteamID64 → SteamID2** en Python (bigint, trivial) y escribe el `STEAM_1:Y:Z`
ya listo, para que el plugin no haga aritmética de 64 bits (SourcePawn es int de 32 bits):
```python
def steam64_to_steam2(sid64: int) -> str:
    acct = sid64 - 76561197960265728
    return f"STEAM_1:{acct & 1}:{acct >> 1}"
```

**Flags del reservador** (`RESERVER_FLAGS`, configurable en `agent.conf`, default **`bcfgij`**):
`b` generic · `c` kick · `f` slay · `g` changemap · `i` config (comandos de match de ZoneMod) ·
`j` chat. **Excluidos a propósito:** `d` ban, `e` unban, `m` rcon, `n` cheats, `z` root. Cumple
"kick, cambiar mapa, controlar match; SIN ban" (D3). El set exacto que exige `!match`/`!forcestart`
de ZoneMod se confirma en la caja (pregunta abierta); por eso es configurable.

### 5.3 Pseudocódigo `panel_admin.sp`

```sourcepawn
#include <sourcemod>
#pragma semicolon 1
#pragma newdecls required

public Plugin myinfo = {
    name = "Panel Admin (por-servidor)", author = "Luciano Giraldo",
    description = "Concede admin en runtime al reservador de ESTE puerto, leyendo data/panel/admins-<port>.txt",
    version = "1.0.0", url = ""
};

ArrayList g_Panel;          // AdminId que este plugin creó (para revocarlos limpio)
char      g_File[PLATFORM_MAX_PATH];

public void OnPluginStart() {
    int port = FindConVar("hostport").IntValue;          // MI puerto (6033..6036)
    BuildPath(Path_SM, g_File, sizeof(g_File), "data/panel/admins-%d.txt", port);
    g_Panel = new ArrayList();
    RegServerCmd("panel_admin_reload", Cmd_Reload, "Relee admins-<port>.txt (lo llama el agente por RCON)");
}

public void OnConfigsExecuted() {   // tras cargar admins_simple.ini → no lo pisamos
    ApplyFromFile();
}

// Late-joiner: si el reservador conecta después del seed, se le aplica al autorizarse.
public void OnClientPostAdminCheck(int client) {
    ApplyFromFile();                 // barato (1 línea normalmente); re-evalúa
    RunAdminCacheChecks(client);
}

Action Cmd_Reload(int args) { ApplyFromFile(); return Plugin_Handled; }

void ApplyFromFile() {
    // 1) revocar lo que ESTE plugin concedió antes (no toca admins_simple.ini)
    for (int i = 0; i < g_Panel.Length; i++) RemoveAdmin(view_as<AdminId>(g_Panel.Get(i)));
    g_Panel.Clear();

    File f = OpenFile(g_File, "r");
    if (f == null) return;           // sin archivo = sin admin panel (server limpio)

    char line[128], sid[64], flags[32];
    while (f.ReadLine(line, sizeof(line))) {
        TrimString(line);
        if (line[0] == '\0' || line[0] == '#') continue;
        int p = BreakString(line, sid, sizeof(sid));
        if (p == -1) continue;
        strcopy(flags, sizeof(flags), line[p]); TrimString(flags);

        AdminId aid = CreateAdmin("");
        for (int c = 0; flags[c] != '\0'; c++) {
            AdminFlag fl;
            if (FindFlagByChar(flags[c], fl)) aid.SetFlag(fl, true);
        }
        aid.ImmunityLevel = 1;                       // por encima de jugadores normales, no del operador
        BindAdminIdentity(aid, AUTHMETHOD_STEAM, sid); // sid = "STEAM_1:Y:Z"
        g_Panel.Push(aid);
    }
    delete f;

    // aplicar a los ya conectados
    for (int i = 1; i <= MaxClients; i++)
        if (IsClientInGame(i) && !IsFakeClient(i)) RunAdminCacheChecks(i);
}
```

**Notas:**
- Como el plugin aplica en `OnClientPostAdminCheck`, **el reservador (que conecta después del seed)
  obtiene admin sin necesidad de RCON**. El `panel_admin_reload` por RCON solo hace falta para
  re-sembrar a alguien **ya conectado** (slot reciclado / `RESEED_ADMIN`).
- `RemoveAdmin` sobre los AdminId propios **no** borra los del operador de `admins_simple.ini`
  (esos los gestiona `admin_manager`); se preserva la separación.
- `ImmunityLevel = 1`: el reservador no puede kickear al operador (que debe tener inmunidad mayor,
  p. ej. `99:z`).

### 5.4 Integración con el unloader parcheado (obligatorio)
Añadir la línea al array `gKeep[][]` de `predictable_unloader.sp` y **recompilar** ambos `.smx`:

```sourcepawn
char gKeep[][] = {
    "chat_logger.smx",
    "admin_manager.smx",
    "idle_hibernate.smx",
    "panel_admin.smx"        // <-- NUEVO: sobrevive el churn de matchmode
};
```
Y en `tasks/fleet.yml`, agregar `panel_admin.smx` al loop "Install custom SourceMod plugins" y
`panel_admin.sp` al loop de fuentes. Crear el dir con setgid:
```yaml
- name: Panel admin data dir (setgid para que el agente escriba y el juego lea)
  ansible.builtin.file:
    path: "{{ install_dir }}/left4dead2/addons/sourcemod/data/panel"
    state: directory
    owner: "{{ steam_user }}"
    group: "{{ steam_user }}"
    mode: "2775"
```

---

## 6. Auto-apagado: 4 sostenes con comandos exactos

**Regla:** `hold = servers_active OR intent_active OR sourcebans_recent OR ssh_active OR boot_grace
OR shutdown_inhibit(nube)`. Si `NOT hold` de forma **estable** (debounce, ver §6.6) → `poweroff`.
Todos los sostenes son **verificables localmente** ⇒ el apagado funciona **sin internet**
(`shutdown_inhibit` solo puede *mantener viva*, nunca es requisito para apagar).

### 6.1 Sostén #1 — servidor activo (jugadores, o vacío hace <15 min)
Fuente primaria: **scrape del exporter** `http://127.0.0.1:9101/` (ya corre). Parsear texto Prometheus:
`l4d2_service_up{instance="k"}`, `l4d2_up{...}`, `l4d2_players{...}`, `l4d2_bots{...}`,
`l4d2_map_info{...,map="..."}`. `humans = players - bots`.

Mantener por slot `empty_since[k]`:
```python
for k in slots_running:
    if humans[k] > 0:
        empty_since[k] = None
    elif empty_since[k] is None:
        empty_since[k] = now             # acaba de quedar vacío
servers_active = any(
    unit_active(k) and (humans[k] > 0 or (now - empty_since[k]) < 900)   # 15 min
    for k in range(1, N+1)
)
```
Además, **política local de cierre** (dueño: agente): si `unit_active(k)` y
`empty_since[k]` y `now - empty_since[k] >= 900` → el agente ejecuta el cierre local
(equivalente a `STOP_SERVER(k)`: `fleetctl stop k` + borrar archivo admin) y lo reporta en el
próximo `/poll` (la nube libera el slot y promueve la cola). Esto es lo que evita que un servidor
vacío mantenga viva la PC para siempre y hace que "apagar al instante cuando todo está cerrado" no
provoque flapping (ya esperó sus 15 min).

Verificación manual / fallback A2S (si el exporter está caído): mismo A2S del exporter directo a
`(GAME_IP, port)` — reusar `query()` de `l4d2_exporter.py` verbatim. `GAME_IP` sale de `fleet.env`
o auto-detect (srcds **no** responde A2S en `127.0.0.1`).

Comando de comprobación puntual (debug): `curl -s localhost:9101 | grep -E 'l4d2_(service_up|players|bots)'`.

### 6.2 Sostén #2 — intent/encendido en curso
Dos señales, OR:
1. **Local:** hay un `START_SERVER`/`RESTART_SERVER` **en vuelo** en el journal (§10), o
   `boot_grace` (ver §6.5).
2. **Nube:** `shutdown_inhibit=true` en la última respuesta de `/poll` (la nube lo pone cuando hay
   intents activos, o cola con gente esperando un slot por liberarse — §10 de la spec).

```python
intent_active = has_inflight_start() or last_resp.shutdown_inhibit
```
No hay comando de shell: es estado del propio agente + flag de la nube.

### 6.3 Sostén #3 — SourceBans usado en los últimos 10 min
Señal = actividad HTTP reciente en el vhost `/sourcebans`. Método recomendado (mínimo código):
**mtime del access log** que nginx escribe para ese vhost.

```bash
# devuelve epoch de la última escritura del log; el agente compara now - mtime < 600
stat -c %Y /var/log/nginx/sourcebans_access.log
```
```python
def sourcebans_recent():
    try:
        m = os.stat("/var/log/nginx/sourcebans_access.log").st_mtime
        return (time.time() - m) < 600      # 10 min
    except FileNotFoundError:
        return False                         # sin panel/log → no es sostén
```
**Dependencia (dominio SourceBans/web):** el vhost de `/sourcebans` debe tener
`access_log /var/log/nginx/sourcebans_access.log;` propio (ruta configurable en `agent.conf` →
`SOURCEBANS_ACCESS_LOG`). Alternativa portable si no se quiere depender del flavor del web server:
un `auto_prepend_file` PHP de una línea que `touch /run/l4d2-panel/sourcebans.last` en cada request,
y el agente hace `stat` de ese marcador. Cualquiera de las dos; la del access log no requiere PHP.

> El MySQL de SourceBans lo escribe LAC cuando **hay un servidor corriendo** (banea al conectado);
> eso ya está cubierto por el sostén #1. El sostén #3 es específicamente para el **operador
> navegando el panel** con todos los servidores cerrados.

### 6.4 Sostén #4 — sesión SSH activa del operador
Detectar una sesión SSH interactiva **sin root** y **agnóstico al puerto** (sshd podría estar en 22;
:2222 es de InfoGestion): contar procesos de sesión de sshd, que se titulan `sshd: <user>@pts/N` o
`sshd: <user>@notty` (el listener priv-sep es `sshd: /usr/sbin/sshd` y **no** matchea `@`).

```bash
# > 0  ⇒  hay al menos una sesión SSH establecida
pgrep -c -f 'sshd:.*@'
```
```python
def ssh_active():
    try:
        n = int(subprocess.run(["pgrep","-c","-f","sshd:.*@"],
                                capture_output=True, text=True, timeout=3).stdout or "0")
        return n > 0
    except Exception:
        return _ssh_active_fallback()
```
**Caveat `hidepid`:** si `/proc` está montado con `hidepid=2`, un no-root no ve procesos de otros
usuarios y `pgrep` fallaría. Ubuntu por default **no** activa `hidepid` → funciona. Fallback
independiente (conexiones establecidas hacia el puerto del sshd, sin `-p` no necesita root):
```bash
# fallback: alguna conexión TCP establecida a 22 o 2222 con destino local
ss -tnH state established '( sport = :22 or sport = :2222 )' | grep -q . && echo 1 || echo 0
```
`who` (líneas con host entre paréntesis distinto de `(:0)`) sirve de tercer cross-check. El agente
usa `pgrep` como primario y `ss` como fallback.

### 6.5 Boot grace (evita apagar una PC recién despertada mid-reserva)
La NIC tarda ~15-30 s en modo WoL y el intent que despertó la PC puede tardar en llegar como
`START_SERVER`. Durante los primeros **`BOOT_GRACE=180 s`** de uptime, el agente **no apaga**:
```python
boot_grace = uptime_s() < BOOT_GRACE      # /proc/uptime
```
Esto cubre el caso "WoL despertó la PC pero el primer poll/commando aún no llega".

### 6.6 Decisión, debounce y dry-run
```python
hold = servers_active or intent_active or sourcebans_recent or ssh_active or boot_grace \
       or last_resp.shutdown_inhibit
if hold:
    idle_since = None
else:
    idle_since = idle_since or now
    if now - idle_since >= IDLE_CONFIRM:   # 60 s: 2-3 ciclos sin ningún sostén
        do_poweroff()
```
- `IDLE_CONFIRM=60 s` evita apagar por un parpadeo (p. ej. exporter reiniciando). No hay flapping:
  cada server ya esperó 15 min vacío antes de cerrarse.
- **`do_poweroff()`**: reporta `poweroff_intent` en un último `/poll` best-effort → `fleetctl stop`
  de cada unit activa (SIGINT limpio) → `sudo systemctl poweroff`.
- **Modo dry-run (`DRY_RUN=1` en `agent.conf`):** ninguna acción local mutante se ejecuta; se
  **loguea** `WOULD poweroff` / `WOULD stop l4d2@k` / `WOULD start`. Imprescindible en el primer
  deploy para no apagar la caja mientras se prueba.
- **Subcomando de diagnóstico:** `python3 agent.py --check-sustains` corre los 4 chequeos, imprime
  cada señal, el `hold` resultante y la decisión, y **sale** (no toca nada). Para depurar en vivo.

```
$ python3 agent.py --check-sustains
servers_active   = True   (slot1 humans=3; slot3 vacío hace 412s)
intent_active    = False  (inflight=0, inhibit=False)
sourcebans_recent= False  (last access hace 3h)
ssh_active       = True   (pgrep sshd:.*@ = 1)
boot_grace       = False  (uptime 5411s)
--> HOLD = True  ⇒  NO apagar
```

---

## 7. Verificación de salud (A2S + plugins vía RCON)

`verify_health(k, warmup_s)` declara **`ok`** cuando: **(a)** A2S responde y **(b)** los plugins
requeridos están cargados.

```python
REQUIRED_PLUGINS = ["panel_admin", "admin_manager", "chat_logger", "idle_hibernate"]

def verify_health(k, warmup_s):
    port = PORT_BASE + k
    t0 = monotonic()
    while monotonic() - t0 < warmup_s:
        info = a2s_or_exporter(k)                 # A2S directo o scrape :9101
        if info and info["up"]:
            loaded = rcon_plugins_loaded(port)    # RCON "sm plugins list"
            missing = [p for p in REQUIRED_PLUGINS if p not in loaded]
            if not missing:
                return True, info
            rcon(port, "sm plugins refresh")      # intento de recuperación
        sleep(2)
    return False, {"missing": missing if 'missing' in dir() else None}
```

Estados de salud reportados por slot:
| health | Significado | Acción del agente |
|---|---|---|
| `ok` | A2S up + plugins cargados | Ninguna |
| `starting` | unit activo, A2S aún no (dentro de warmup) | Esperar |
| `degraded` | A2S up pero falta un plugin | `sm plugins refresh` (una vez), re-chequear |
| `down` | unit activo, A2S muerto pasado el warmup | Reportar; la nube puede `RESTART_SERVER` |
| `stopped` | unit inactivo | Ninguna |

### 7.1 Cliente RCON (Source RCON, TCP a `127.0.1.1:<port>`)
No existe cliente en el repo → el agente implementa el protocolo (TCP, no UDP). **Bind en
`127.0.1.1`** (no `.0.0.1`, por el `/etc/hosts` de Ubuntu). Password = `RCON_PASSWORD` de `fleet.env`.

Formato de paquete (little-endian): `int32 size | int32 id | int32 type | body\0 | \0`
donde `size = 4 + 4 + len(body) + 2`. Tipos: `3`=AUTH, `2`=EXECCOMMAND, `0`=RESPONSE_VALUE,
`2`=AUTH_RESPONSE.

```python
import socket, struct
def rcon(host, port, password, command, timeout=3):
    def pkt(pid, ptype, body):
        b = body.encode() + b"\x00\x00"
        return struct.pack("<iii", len(b)+8, pid, ptype) + b
    def readpkt(s):
        raw = s.recv(4); (size,) = struct.unpack("<i", raw)
        data = b""
        while len(data) < size: data += s.recv(size-len(data))
        pid, ptype = struct.unpack("<ii", data[:8])
        return pid, ptype, data[8:-2].decode("utf-8","replace")
    s = socket.create_connection((host, port), timeout); s.settimeout(timeout)
    try:
        s.sendall(pkt(1, 3, password))          # AUTH
        pid, ptype, _ = readpkt(s)              # puede venir un RESPONSE_VALUE vacío primero
        if ptype == 0: pid, ptype, _ = readpkt(s)
        if pid == -1: raise PermissionError("RCON auth failed")   # id -1 = password malo
        s.sendall(pkt(2, 2, command))           # EXECCOMMAND
        _, _, out = readpkt(s)                  # respuestas cortas: 1 paquete basta
        return out
    finally:
        s.close()
```
`rcon_plugins_loaded(port)` = ejecutar `"sm plugins list"` y buscar los nombres en la salida
(la lista muestra `"<Nombre>" ... por autor`; matchear por substring del nombre declarado en `myinfo`).
`host` por default `127.0.1.1`, con fallback a `127.0.0.1` si connect falla (config `RCON_HOST`).

---

## 8. Watchdog del churn de matchmode

**Síntoma:** en servidores **vacíos**, `!match`/`!unmatch` se traban (candado de confogl + timers
congelados por la hibernación de L4D2), y el `pred_unload` deja plugins caídos.

**Estrategia (proactiva, segura porque el server está vacío):** cuando un slot **transiciona a
vacío** (`humans` pasó de >0 a 0) y se asienta (esperar `WATCHDOG_SETTLE=20 s`), el agente ejecuta
**una vez** por episodio de vacío:
```
rcon(port, "sm plugins refresh")
```
y verifica que los `REQUIRED_PLUGINS` volvieron (si falta alguno: `rcon(port, "sm plugins load <x>")`).
Esto limpia el residuo del churn **mientras nadie juega**, dejando el server listo para el próximo
match. Además, en `START_SERVER` sobre un slot **reciclado** (que estuvo usado antes), el `verify_health`
ya corre `refresh` si detecta un plugin faltante, garantizando pizarra limpia para el nuevo reservador.

**Guardas:**
- **Nunca** correr `refresh` con `humans > 0` (rompería un match en vivo). El watchdog solo dispara
  con el server vacío.
- Rate-limit: **una** vez por episodio de vacío (flag `watchdog_done[k]`, se resetea cuando el slot
  vuelve a tener humanos o se cierra).
- El comando `REFRESH_PLUGINS(k)` (§4) permite a la nube/operador forzarlo manualmente (también con
  la guarda de vacío).

Detectar el trabado con precisión (leer el candado de confogl) requeriría un comando RCON custom que
hoy no existe; para hobby, **el refresh proactivo en vacío es suficiente** y evita el problema en
vez de diagnosticarlo. No se sobre-ingeniería un detector fino.

---

## 9. Detección y reporte de cambio de IP pública

- **Autoridad = la nube.** En cada `/poll`, la Lambda extrae la IP de origen del header
  `X-Forwarded-For` (CloudFront) y la devuelve como `observed_ip`. La nube **compara con la última
  conocida** en el `Host` item y, si cambió, **actualiza el registro Route53**
  (`home.l4d2.ventrax.dev` A, TTL 60 s) para que CloudFront pueda alcanzar el origen `/sourcebans`.
  **Las credenciales AWS viven en la nube, NO en la PC de casa** (decisión de seguridad).
- **El agente** hace best-effort self-detect para incluir `public_ip` en el request (cross-check y
  para logs), cacheado 5 min para no golpear nada cada 12 s:
  ```python
  # cache 5 min; usa un endpoint AWS estable, texto plano
  ip = urlopen("https://checkip.amazonaws.com", timeout=5).read().decode().strip()
  ```
  Si `checkip` falla, el agente omite `public_ip` y confía en `observed_ip` de la respuesta.
- **Al conectar** (`steam://connect/<ip>:<port>` en READY), el agente usa la **IP autoritativa**:
  prioriza `observed_ip` de la última respuesta; si aún no la tiene, cae a su self-detect. Así el
  connect string siempre lleva la IP que la nube confirmó.
- **Post-boot:** la IP puede haber cambiado desde la sesión anterior. El primer `/poll` tras bootear
  re-sincroniza `observed_ip` y dispara la actualización DDNS en la nube; con TTL 60 s, `/sourcebans`
  se recupera en ~1 min. El agente persiste la última IP en `/var/lib/l4d2-panel/last_ip` solo para
  logging/diagnóstico.

**Dependencia (dominio nube):** la Lambda `/agent/*` debe (a) devolver `observed_ip` desde XFF y
(b) actualizar Route53 cuando cambie. El agente **no** toca Route53.

---

## 10. Resiliencia

### 10.1 Sin internet / DNS / connection refused / 5xx / 429
- `try/except` alrededor del POST. En fallo: log a nivel WARNING (no ERROR para no floodear),
  **backoff exponencial** desde `POLL_INTERVAL` (12 s) ×1.6 hasta cap **120 s**, con jitter; **reset
  a 12 s** en el primer éxito.
- **Crucial:** durante el offline, la **política local sigue corriendo cada ciclo** (empty-close,
  sostenes, poweroff). Como los 4 sostenes son locales, la PC se cierra sola correctamente aunque la
  nube esté caída. Lo único que se pierde offline es **recibir nuevos comandos** (no se pueden
  levantar servidores nuevos) — aceptable: la PC simplemente cierra lo vacío y se apaga.
- `429`/`503`: respetar `Retry-After` si viene; si no, backoff normal. No ejecutar comandos de una
  respuesta con error HTTP.

### 10.2 Auth 401/403
- Reintentar con backoff. Tras **3** 401/403 seguidos, **releer** `/etc/l4d2-fleet/agent.token`
  (por si el operador rotó el token en caliente). Log a ERROR una vez (visible en `journalctl`), sin
  spamear. Nunca ejecutar comandos sin auth válida.

### 10.3 Idempotencia y comandos a medio ejecutar
- **Journal persistente** `/var/lib/l4d2-panel/journal.json`: `{cmd_id: {type,k,status,ts,result}}`,
  con los últimos ~50 comandos. Escritura atómica (tmp+rename).
- Al recibir un `cmd_id` ya en journal con `status in {done,failed,expired}`: **no re-ejecutar**,
  re-reportar el resultado cacheado (y re-ackear en `/poll.acks`).
- Al recibir un `cmd_id` en `in_progress` tras un **restart del agente**: **reconciliar por estado
  real** (`unit_active`, A2S, presencia de `admins-<port>.txt`) en vez de re-ejecutar a ciegas; si
  el estado ya cumple el objetivo → `done`; si no → continuar la convergencia.
- **Superseder:** si llega un comando para el mismo `k` que contradice uno en vuelo (p. ej. STOP
  mientras un START corre), gana el más nuevo (`issued_at`); el viejo se marca `superseded`.
- **Cross-reboot:** el journal sobrevive al restart del proceso pero un `poweroff` reinicia todo a
  cero (nada corriendo). Tras reboot, `boot_id` nuevo señala a la nube que re-emita los START que
  necesite. El agente **no** re-arranca servidores por cuenta propia al bootear (bootea ocioso).
- **Timeouts por comando:** START/RESTART fallan a `FAILED` tras `warmup + margen` (~60 s) para que
  la nube reintente o avise al operador. Ningún comando bloquea el bucle (todo con timeout).

### 10.4 Auto-recuperación del agente
- `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=0` (nunca se rinde). Sin `WatchdogSec`
  para v1 (simplicidad); si se quiere, `sd_notify` con watchdog de 60 s es un add-on trivial.
- Log a **journald** (stdout + `logging`), nivel `INFO` por defecto, `DEBUG` si `agent.conf` lo pide.

### 10.5 Reloj
- Intervalos y backoff con **reloj monótono** (`time.monotonic()`), inmune a saltos de NTP.
- `ts` de los payloads con reloj de pared (`time.time()`). `deadline` de comandos se evalúa contra
  el reloj de pared; margen de 300 s tolerado por el skew (mismo que el HMAC).

---

## 11. sudoers scoped (exacto)

El agente solo necesita elevar para **arrancar/parar/reiniciar los units `l4d2@k`** y **apagar**.
Patrón seguro: **wrapper root `fleetctl`** que valida verbo + índice, y sudoers que solo permite ese
wrapper (evita los comodines laxos de sudoers y cualquier ambigüedad de `l4d2@*`).

### 11.1 Wrapper `/opt/l4d2-fleet/agent/fleetctl` (root:root, 0755, NO escribible por el agente)
```bash
#!/usr/bin/env bash
# fleetctl <start|stop|restart> <k>   |   fleetctl poweroff
set -euo pipefail
case "${1:-}" in
  start|stop|restart)
    k="${2:-}"
    [[ "$k" =~ ^[1-9][0-9]?$ ]] || { echo "k inválido" >&2; exit 2; }
    exec /usr/bin/systemctl "$1" "l4d2@${k}.service" ;;
  poweroff)
    exec /usr/bin/systemctl poweroff ;;
  *)
    echo "uso: fleetctl <start|stop|restart> <k> | fleetctl poweroff" >&2; exit 2 ;;
esac
```

### 11.2 `/etc/sudoers.d/l4d2-agent` (0440, validado con `visudo -c`)
```
Defaults:l4d2agent   !requiretty, env_reset, secure_path="/usr/sbin:/usr/bin:/sbin:/bin"
l4d2agent ALL=(root) NOPASSWD: /opt/l4d2-fleet/agent/fleetctl
```
Con el wrapper, esta única línea basta y es segura: el agente **solo** puede invocar `fleetctl`, que
a su vez **solo** hace `systemctl (start|stop|restart) l4d2@<1-99>.service` o `systemctl poweroff`.
No puede arrancar cualquier otro unit ni pasar flags arbitrarios.

**Defensa en profundidad opcional** (si se prefiere sin wrapper, sudoers directo con líneas
explícitas por-unit generadas por Ansible para `1..server_count`):
```
l4d2agent ALL=(root) NOPASSWD: /usr/bin/systemctl start l4d2@1.service, \
    /usr/bin/systemctl stop l4d2@1.service, /usr/bin/systemctl restart l4d2@1.service
# ... (repetir 2..N) ...
l4d2agent ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
```
El wrapper es preferible: una sola línea, `k` validado, N no cableado. Si N crece más allá de lo
provisionado, `fleetctl` acepta `k` pero `systemctl start l4d2@k` fallará si el unit no está en el
sistema — el agente lo reporta como `FAILED` y el operador re-provisiona. (Cambiar N = re-correr
Ansible; es una operación de operador, no de runtime.)

---

## 12. Configuración, archivos y permisos (referencia)

`/etc/l4d2-fleet/agent.conf` (templated, **no secreto**, `0644`):
```ini
[agent]
host_id = l4d2-home
endpoint = https://l4d2.ventrax.dev/agent
poll_interval_s = 12
backoff_max_s = 120
boot_grace_s = 180
idle_confirm_s = 60
empty_close_s = 900
watchdog_settle_s = 20
reserver_flags = bcfgij
rcon_host = 127.0.1.1
sourcebans_access_log = /var/log/nginx/sourcebans_access.log
dry_run = 0
log_level = INFO
```
(`PORT_BASE`, `GAME_IP`, `RCON_PASSWORD` se leen de `/etc/l4d2-fleet/fleet.env`, no se duplican.)

| Ruta | Modo / dueño | Contenido |
|---|---|---|
| `/opt/l4d2-fleet/agent/agent.py` | `0755 root` | el agente |
| `/opt/l4d2-fleet/agent/fleetctl` | `0755 root` | wrapper de sudo |
| `/etc/l4d2-fleet/agent.conf` | `0644 root` | config no-secreta |
| `/etc/l4d2-fleet/agent.token` | `0400 l4d2agent` | token de dispositivo (secreto) |
| `/etc/l4d2-fleet/fleet.env` | `0640 steam:steam` | ya existe; RCON_PASSWORD, PORT_BASE, GAME_IP |
| `/var/lib/l4d2-panel/` | `0750 l4d2agent` | journal.json, last_ip |
| `/run/l4d2-panel/` | `0750 l4d2agent` | marcadores efímeros (RuntimeDirectory) |
| `…/addons/sourcemod/data/panel/` | `2775 steam:steam` | `admins-<port>.txt` (agente escribe, juego lee) |
| `/etc/sudoers.d/l4d2-agent` | `0440 root` | sudoers scoped |
| `/etc/systemd/system/l4d2-agent.service` | `0644 root` | unit del agente |

---

## 13. Supuestos sobre otros dominios (declarados)

1. **Nube/backend** expone `POST /agent/poll` y `POST /agent/report` (CloudFront behavior `/agent/*`
   → Lambda Function URL) con el contrato de §2; valida `Bearer` (+HMAC opcional) contra el `Host`
   item de DynamoDB; devuelve `observed_ip`, `server_count`, `poll_interval_s`, `shutdown_inhibit` y
   `commands`; **es dueña** de propiedad de slots, cola, intents; **emite** START/STOP/POWEROFF;
   **actualiza** Route53 DDNS; **dispara** WoL. El agente no hace nada de eso.
2. **N (server_count)** vive en el `Config` item de DynamoDB (autoritativo) y llega en cada `/poll`.
   El **techo provisionado** (units + sudoers) por Ansible debe ser `>= N`. Subir N por encima del
   techo requiere re-provisionar (operación de operador, no runtime).
3. **Modelo de la flota cambia**: en la caja del panel, `l4d2@k` **no** se habilita al boot; el
   agente los arranca bajo demanda. (Cambio requerido en `tasks/fleet.yml`, §1.3.)
4. **Plugin nuevo `panel_admin.smx`** se compila, despliega, y se agrega a `gKeep` del
   `predictable_unloader` (recompilar). `FindConVar("hostport")` refleja el `-port` real en runtime
   (mismo supuesto que ya usa `chat_logger`).
5. **Dominio SourceBans/web** provee una señal de "uso reciente": access log dedicado del vhost
   `/sourcebans` (ruta en `agent.conf`) o un marcador `touch`. Provisionado por ese dominio.
6. **Login Steam** entrega **SteamID64** (17 dígitos). La conversión a SteamID2 la hace el agente.
7. **Token** se coloca fuera del repo (ansible-vault o manual); la nube guarda su hash y soporta
   doble-validez en rotación.
8. **`GAME_IP`/`RCON_PASSWORD`** correctos en `fleet.env` (ya gestionado por el rol). RCON en
   `127.0.1.1:<port>`.

---

## 14. Qué queda fuera (para no sobre-ingenierizar)

- **Sin** cliente/servidor persistente propio, sin cola de mensajes, sin WebSocket: polling HTTPS
  cada 12 s es suficiente para decenas de usuarios.
- **Sin** detector fino del candado de confogl: el `refresh` proactivo en vacío evita el problema.
- **Sin** comandos de kick/mapa/ban en el agente: el reservador es admin in-game; el ban es LAC/operador.
- **Sin** credenciales AWS en la PC de casa: la nube hace DDNS/WoL.
- **Sin** `pip`/venv/dependencias: stdlib basta.
- **Sin** polkit ni sandbox máximo en v1: sudo + wrapper es suficiente (polkit anotado como opcional).
- **Sin** tests automatizados (preferencia del usuario): verificación manual + `--check-sustains` +
  `dry_run`.
```
