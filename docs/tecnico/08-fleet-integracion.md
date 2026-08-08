# 08 — Integración con la flota (`l4d2-fleet`)

> Dominio: **fleet**. Diseño técnico de todo lo que corre en la **PC de casa** y se provisiona
> extendiendo el rol Ansible existente `l4d2-fleet`
> (`/home/ventrax/modules/personal/l4d2-fleet/`).
>
> Cubre: MariaDB + SourceBans++ (+ LAC persistente), el **agente** de la nube, el **plugin de
> admin por-servidor**, nginx+php-fpm para el panel, DNS dinámico, la protección del estado
> runtime frente al re-provisioning de ZoneMod, el reuso de la lógica A2S, las variables nuevas,
> el watchdog del churn de matchmode y el impacto sobre el monitoreo.
>
> Fuente de verdad de producto: `docs/especificaciones-v1.md`. Este documento es suficiente para
> implementar sin re-diseñar.

---

## 0. Resumen del dominio

La PC de casa hoy corre **solo la flota ZoneMod** (`l4d2@1..N`) más el stack de monitoreo, todo
provisionado por el rol `l4d2_fleet`. Este proyecto le agrega **cuatro piezas nuevas** y **un
plugin**, todas por Ansible en el mismo rol:

| # | Pieza | Qué es | Servicio systemd | Puerto |
|---|-------|--------|------------------|--------|
| 1 | **Agente** | Proceso Python que hace polling saliente HTTPS a la nube, ejecuta comandos (levantar/cerrar server, sembrar admin, apagar), aplica la lógica de sostenes y el watchdog de matchmode | `l4d2-agent.service` | — (solo saliente) |
| 2 | **MariaDB + SourceBans++** | DB local de bans (persiste LAC + operador) | `mariadb.service` | `127.0.0.1:3306` |
| 3 | **Panel SourceBans++ (PHP)** | Web PHP servida por nginx+php-fpm; CloudFront la alcanza por DDNS en `/sourcebans` | `nginx.service`, `php8.x-fpm.service` | `sb_web_listen` (def `8081`) |
| 4 | **DDNS** | Mantiene un hostname apuntando a la IP pública cambiante de casa (recomendado: lo hace la nube desde el heartbeat) | — (parte del agente) | — |
| 5 | **Plugin `fleet_admin`** | SourceMod plugin que da admin **por-servidor** (por `hostport`) al reservador, sin tocar el `admins_simple.ini` global | dentro de `l4d2@N` | — |

Todo se gobierna con dos interruptores nuevos en `defaults/main.yml`: `with_sourcebans` y
`with_agent` (ambos `true` por defecto). Ajuste de ambición: es un hobby de pocos servidores y
decenas de usuarios; se evita cualquier automatización frágil (ver §5.4, el setup del esquema
SourceBans++ se hace **una vez** por el instalador web, no se sobre-automatiza).

---

## 1. Árbol de cambios en el repo `l4d2-fleet`

```
roles/l4d2_fleet/
├── defaults/main.yml                         # (EDIT) variables nuevas §2
├── tasks/
│   ├── main.yml                              # (EDIT) importa sourcebans.yml + agent.yml §3
│   ├── zonemod.yml                           # (EDIT) protege admins_simple.ini §4
│   ├── fleet.yml                             # (EDIT) instala fleet_admin.smx, condiciona el arranque de units §5,§7
│   ├── sourcebans.yml                        # (NUEVO) MariaDB + SB++ + nginx/php §6
│   ├── agent.yml                             # (NUEVO) usuario, venv, unit, token, sudoers §7
│   └── monitoring.yml                        # (EDIT) promtail del agente §10
├── handlers/main.yml                         # (EDIT) restart mariadb/nginx/php/agent §6,§7
├── templates/
│   ├── agent.env.j2                          # (NUEVO) token + config del agente §7
│   ├── l4d2-agent.service.j2                 # (NUEVO) unit del agente §7
│   ├── databases.cfg.j2                      # (NUEVO) SourceBans++ → MySQL §6
│   ├── sourcebans.config.php.j2              # (NUEVO) config del panel PHP §6
│   ├── nginx-sourcebans.conf.j2              # (NUEVO) server block §6
│   ├── sudoers-l4d2agent.j2                  # (NUEVO) sudoers scoped §7
│   ├── promtail.yml.j2                       # (EDIT) job del agente §10
│   └── ddns-route53.env.j2 / ddns.sh         # (NUEVO, solo ddns_mode=local) §9
└── files/
    ├── a2s.py                                # (NUEVO) módulo A2S compartido §8
    ├── l4d2_exporter.py                      # (EDIT) importa a2s §8
    ├── agent/agent.py                        # (NUEVO) el agente §7
    ├── agent/rcon.py                         # (NUEVO) cliente Source RCON TCP §7
    ├── fleetctl                              # (NUEVO) wrapper root para systemctl/poweroff §7
    └── custom-plugins/
        ├── fleet_admin.smx                   # (NUEVO) compilado §5
        ├── scripting/fleet_admin.sp          # (NUEVO) fuente §5
        ├── scripting/predictable_unloader.sp # (EDIT) agrega "fleet_admin.smx" a gKeep §5
        └── optional/predictable_unloader.smx # (EDIT) recompilado §5
```

`group_vars/all.yml.sample` también se edita (§2). Los secretos van en `group_vars/vault.yml`
(ansible-vault) — el `.gitignore` ya matchea `*vault*` y `group_vars/all.yml`, así que nada de
esto llega al repo público.

---

## 2. Variables nuevas

### 2.1 `roles/l4d2_fleet/defaults/main.yml` (valores por defecto, NO secretos)

```yaml
# ===== Integración L4D2 Panel =====
with_sourcebans: true            # instala MariaDB + SourceBans++ + panel PHP (nginx/php-fpm)
with_agent: true                 # instala el agente de la nube

# --- Agente ---
panel_api_base: ""               # URL base de la API en la nube (se setea en all.yml, no es secreto)
agent_user: l4d2agent
agent_home: /opt/l4d2-fleet/agent
agent_poll_interval: 12          # segundos entre heartbeats
agent_empty_grace: 900           # 15 min: server vacío se cierra tras esto (D11)
agent_sourcebans_grace: 600      # 10 min: SourceBans mantiene viva la PC (sostén #3)
agent_boot_start_units: false    # con el panel las units NO arrancan al boot; el agente las gobierna (§7.6)
# agent_device_token: ""         # SECRETO -> group_vars/vault.yml (bearer del agente)

# --- SourceBans / DB ---
sb_db_name: sourcebans
sb_db_user: sbpp
sb_db_host: 127.0.0.1
sb_db_port: 3306
sb_web_root: /var/www/sourcebans
sb_web_listen: 8081              # puerto local que sirve nginx; CloudFront lo alcanza por DDNS
sourcebans_pp_version: "1.8.0"   # release de sbpp/sourcebans-pp a desplegar
# sb_db_password: ""             # SECRETO -> group_vars/vault.yml

# --- DDNS ---
ddns_mode: cloud                 # 'cloud' = la Lambda de heartbeat actualiza Route53 con la IP
                                 #           que reporta el agente (SIN creds AWS en casa).
                                 # 'local' = script + timer systemd aquí (requiere creds AWS).
ddns_hostname: ""                # p.ej. "origin-sb.ventrax.dev" (solo ddns_mode=local)
ddns_route53_zone_id: ""         # solo ddns_mode=local (Z0798505KCA3V0GU54OJ)
# ddns_aws_access_key_id / ddns_aws_secret_access_key -> SECRETOS, vault, solo modo local
```

### 2.2 `group_vars/all.yml.sample` (plantilla pública; placeholders, sin secretos reales)

Añadir al final:

```yaml
# ===== Integración L4D2 Panel =====
with_sourcebans: true
with_agent: true

# URL pública de la API del panel (sale del deploy CDK). No es secreto.
panel_api_base: "https://l4d2.ventrax.dev"

# DDNS: 'cloud' (recomendado) = la Lambda de heartbeat actualiza Route53 con la IP que
# reporta el agente, así NO hay credenciales AWS en esta PC. 'local' = script + timer aquí.
ddns_mode: cloud

# SECRETOS -> NO los pongas aquí. Créalos en un vault (el .gitignore matchea *vault*):
#   ansible-vault create group_vars/vault.yml
# y dentro:
#   agent_device_token: "..."   # bearer que el agente manda a la nube
#   sb_db_password:     "..."   # password del usuario MySQL de SourceBans
#   # (solo ddns_mode: local)
#   ddns_aws_access_key_id:     "..."
#   ddns_aws_secret_access_key: "..."
```

### 2.3 Manejo de secretos (patrón)

- **Nunca** en `defaults/main.yml` ni en `all.yml.sample` (ambos versionados).
- Van en `group_vars/vault.yml` cifrado con `ansible-vault`. El `.gitignore` existente
  (`*vault*`) lo excluye del repo público. Se corre con `ansible-playbook --ask-vault-pass`.
- Alternativa aceptada para hobby: en `group_vars/all.yml` (ya gitignored), pero el vault es
  preferible porque el archivo puede compartirse/versionarse sin fuga.
- Ansible los escribe a disco en la PC con permisos estrictos (`agent.env` `0640 root:l4d2agent`,
  `databases.cfg` `0640 root:steam`), nunca world-readable.

---

## 3. Orden de ejecución (`tasks/main.yml`)

```yaml
---
- ansible.builtin.import_tasks: dependencies.yml
- ansible.builtin.import_tasks: game.yml
- ansible.builtin.import_tasks: zonemod.yml          # (EDIT) protege el estado runtime (§4)
- ansible.builtin.import_tasks: fleet.yml            # (EDIT) instala fleet_admin, databases.cfg va después del copy
- ansible.builtin.import_tasks: sourcebans.yml       # (NUEVO)
  # when: with_sourcebans | bool   -> se pone en el import con 'when'
- ansible.builtin.import_tasks: agent.yml            # (NUEVO)
  # when: with_agent | bool
- ansible.builtin.import_tasks: monitoring.yml
  when: with_monitoring | bool
```

Forma real del import con guarda:

```yaml
- name: SourceBans++ y panel
  ansible.builtin.import_tasks: sourcebans.yml
  when: with_sourcebans | bool

- name: Agente de la nube
  ansible.builtin.import_tasks: agent.yml
  when: with_agent | bool
```

**Orden importa:** `sourcebans.yml` (que planta `databases.cfg` y los convars de lilac) corre
**después** de `zonemod.yml` (que pisa `configs/`) → no hay riesgo de sobrescritura. `agent.yml`
al final (necesita saber los puertos y que las units existan).

---

## 4. CONFLICTO: `zonemod.yml` pisa el estado runtime — y cómo protegerlo

### 4.1 El problema exacto

`tasks/zonemod.yml` hace, en **cada** `ansible-playbook`:

```yaml
- name: Copy ZoneMod into the game directory
  ansible.builtin.copy:
    src: "/opt/l4d2-fleet/zonemod-src/{{ item }}"
    dest: "{{ install_dir }}/left4dead2/"
    remote_src: true
    loop: [addons, cfg, scripts, host.txt, motd.txt, myhost.txt, mymotd.txt]
```

`copy` con un directorio hace **merge por checksum**: sobrescribe cualquier archivo del destino
cuyo path exista también en el source de ZoneMod, pero **no borra** archivos/directorios que
solo existen en el destino. Consecuencia:

- **`addons/sourcemod/configs/admins_simple.ini`** existe en el source de ZoneMod → **se pisa**
  en cada re-run, perdiendo los admins que `admin_manager` agregó en vivo.
- Cualquier archivo de estado del panel que pusiéramos bajo un path que ZoneMod también trae se
  perdería igual.

### 4.2 Solución (dos mecanismos, ambos de bajo esfuerzo)

**(A) El estado por-servidor vive en un directorio que ZoneMod NO conoce.**
Ponemos el estado del plugin `fleet_admin` en un directorio **nuevo**:

```
{{ install_dir }}/left4dead2/addons/sourcemod/data/l4d2fleet/admins-<port>.txt
```

`data/` existe en el source de ZoneMod, pero el subdirectorio **`l4d2fleet/` no**. Como `copy`
solo sobrescribe paths presentes en el source y **nunca borra** lo que solo está en el destino,
`data/l4d2fleet/` y su contenido **sobreviven intactos a cada re-provision sin tocar
`zonemod.yml`**. Esta es la razón de diseño por la que el estado va ahí y **no** en `configs/`.

**(B) `admins_simple.ini` se preserva con un backup/restore alrededor del copy** (3 tasks en
`zonemod.yml`, sin dependencias nuevas ni cambiar de módulo):

```yaml
# --- al INICIO de zonemod.yml, ANTES del "Copy ZoneMod" ---
- name: ¿Existe ya admins_simple.ini con admins agregados en vivo?
  ansible.builtin.stat:
    path: "{{ admins_ini }}"
  register: admins_ini_stat

- name: Preservar admins_simple.ini antes del sync de ZoneMod
  ansible.builtin.copy:
    src: "{{ admins_ini }}"
    dest: "{{ admins_ini }}.keep"
    remote_src: true
    owner: "{{ steam_user }}"
    group: "{{ steam_user }}"
    mode: "0644"
  when: admins_ini_stat.stat.exists

# --- (el "Copy ZoneMod into the game directory" existente corre aquí) ---

- name: Restaurar admins_simple.ini tras el sync de ZoneMod
  ansible.builtin.copy:
    src: "{{ admins_ini }}.keep"
    dest: "{{ admins_ini }}"
    remote_src: true
    owner: "{{ steam_user }}"
    group: "{{ steam_user }}"
    mode: "0644"
  when: admins_ini_stat.stat.exists

- name: Limpiar el respaldo temporal
  ansible.builtin.file:
    path: "{{ admins_ini }}.keep"
    state: absent
```

donde en `defaults/main.yml` se define la ruta reutilizable:

```yaml
admins_ini: "{{ install_dir }}/left4dead2/addons/sourcemod/configs/admins_simple.ini"
```

Tras el restore, la tarea existente **"Seed server admins"** de `fleet.yml` (que usa `lineinfile`,
no destructivo) re-aplica encima los admins de `group_vars`. Resultado neto: **sobreviven tanto
los admins agregados en vivo como los declarados en `group_vars`**.

> **Nota de producto:** para el operador, la fuente de verdad **entre** re-provisions de los
> admins globales es `group_vars` (o el futuro panel), no `admin_manager` en vivo. `admin_manager`
> sigue siendo útil intra-sesión; el backup/restore evita perder lo suyo, pero no lo convierte en
> base de datos. El admin del **reservador** NO usa este archivo — usa `fleet_admin` (§5), que ni
> siquiera escribe en `configs/`.

**Por qué no `synchronize`/rsync con `--exclude`:** sería más "canónico", pero agrega la collection
`ansible.posix`, no aplica `owner` (habría que chown aparte) y complica el modo local. El par
backup/restore no añade dependencias y es trivial de razonar. Queda anotado como alternativa si en
el futuro se quiere acelerar el copy (rsync evita recalcular checksums de todo `addons/`).

---

## 5. Plugin de admin por-servidor: `fleet_admin`

### 5.1 Por qué un plugin nuevo

`admins_simple.ini` es **global a las N instancias** (un solo install compartido). Dar admin al
reservador **solo en su servidor** requiere discriminar por instancia. SourceMod expone el puerto
de cada instancia en runtime vía el convar **`hostport`** (= puerto de juego, 6033-6036), que es el
discriminador natural. En vez de tocar el archivo global, `fleet_admin` **crea admins en memoria**
(`CreateAdmin` + `SetUserAdmin`), que por naturaleza son **por-proceso/por-servidor** y no se
escriben a disco global.

### 5.2 Diseño

- **Identidad del server:** `g_port = GetConVarInt(FindConVar("hostport"))`.
- **Estado persistente por-puerto:** `addons/sourcemod/data/l4d2fleet/admins-<port>.txt`, una
  línea por SteamID autorizado (SteamID64 o SteamID2). Vive fuera del alcance del copy de ZoneMod
  (§4.2-A). Sirve para re-aplicar si el server reinicia por crash **dentro** de la misma reserva.
- **Flags otorgados al reservador (ADR D3: kick/mapa/match, SIN ban):**
  `b` generic · `c` kick · `g` changemap · `j` chat · `k` vote. **Sin** `d` (ban), `e` (unban),
  `m` (rcon), `n` (cheats), `i`/`h` (config/cvars), `z` (root). `!match`/`!unmatch`/`!forcestart`
  de confogl responden al flag genérico `b`.
- **Aplicación:** en `OnClientPostAdminCheck(client)`, si el SteamID del cliente ∈ set del puerto,
  se le crea/asigna un `AdminId` con esos flags. Al desconectarse, SourceMod limpia solo. Al
  reciclarse el server, el estado se descarta.
- **Comandos (RegServerCmd → solo consola/RCON = el agente):**

  | Comando | Efecto |
  |---|---|
  | `sm_fleet_grant <steamid> [flags]` | agrega el SteamID al set del puerto, escribe el archivo, aplica en vivo si está conectado. `flags` def = `bcgjk` |
  | `sm_fleet_revoke <steamid>` | quita del set, reescribe archivo, revoca del cliente conectado |
  | `sm_fleet_clear` | vacía el set y el archivo (al reciclar el server para un nuevo reservador) |
  | `sm_fleet_list` | imprime el set (debug) |
  | `sm_fleet_reload` | re-lee el archivo del puerto |

- **Arranque:** `OnPluginStart` y `OnMapStart` re-leen el archivo del puerto → set en memoria.

### 5.3 Pseudocódigo (`fleet_admin.sp`)

```sourcepawn
#include <sourcemod>
#pragma semicolon 1
#pragma newdecls required

#define STATE_DIR  "data/l4d2fleet"
#define DEF_FLAGS  "bcgjk"          // kick, changemap, chat, vote, generic (match). SIN ban.

int      g_port;
ArrayList g_authed;                 // SteamID64 (string) autorizados en ESTE puerto

public Plugin myinfo = {
    name = "Fleet Admin (por servidor)", author = "Luciano Giraldo",
    description = "Da admin al reservador SOLO en su servidor (por hostport).",
    version = "1.0.0", url = ""
};

public void OnPluginStart() {
    g_port = GetConVarInt(FindConVar("hostport"));
    g_authed = new ArrayList(ByteCountToCells(32));
    RegServerCmd("sm_fleet_grant",  Cmd_Grant);
    RegServerCmd("sm_fleet_revoke", Cmd_Revoke);
    RegServerCmd("sm_fleet_clear",  Cmd_Clear);
    RegServerCmd("sm_fleet_list",   Cmd_List);
    RegServerCmd("sm_fleet_reload", Cmd_Reload);
    LoadState();
}
public void OnMapStart() { LoadState(); }

void StatePath(char[] p, int n) {
    char dir[PLATFORM_MAX_PATH];
    BuildPath(Path_SM, dir, sizeof(dir), STATE_DIR);
    if (!DirExists(dir)) CreateDirectory(dir, 0775);
    Format(p, n, "%s/admins-%d.txt", dir, g_port);
}

void LoadState() {
    g_authed.Clear();
    char path[PLATFORM_MAX_PATH]; StatePath(path, sizeof(path));
    File f = OpenFile(path, "r"); if (f == null) return;
    char line[64];
    while (f.ReadLine(line, sizeof(line))) { TrimString(line); if (line[0]) g_authed.PushString(line); }
    delete f;
    // re-aplica a los ya conectados (caso reinicio dentro de la reserva)
    for (int c = 1; c <= MaxClients; c++) if (IsClientInGame(c) && !IsFakeClient(c)) TryGrant(c);
}

void SaveState() {
    char path[PLATFORM_MAX_PATH]; StatePath(path, sizeof(path));
    File f = OpenFile(path, "w"); if (f == null) return;
    char sid[32];
    for (int i = 0; i < g_authed.Length; i++) { g_authed.GetString(i, sid, sizeof(sid)); f.WriteLine("%s", sid); }
    delete f;
}

// Compara el SteamID64 del cliente contra el set (normaliza a 64).
bool IsAuthed(int client) {
    char sid64[32]; GetClientAuthId(client, AuthId_SteamID64, sid64, sizeof(sid64));
    return g_authed.FindString(sid64) != -1;
}

void GrantFlags(int client, const char[] flags) {
    AdminId a = GetUserAdmin(client);
    if (a == INVALID_ADMIN_ID) { a = CreateAdmin(""); SetUserAdmin(client, a, true); }
    for (int i = 0; flags[i]; i++) {
        AdminFlag f;
        if (FindFlagByChar(flags[i], f)) a.SetFlag(f, true);
    }
}
void TryGrant(int client) { if (IsAuthed(client)) GrantFlags(client, DEF_FLAGS); }

public void OnClientPostAdminCheck(int client) {
    if (client >= 1 && !IsFakeClient(client)) TryGrant(client);
}

Action Cmd_Grant(int args) {   // sm_fleet_grant <steamid64> [flags]
    char sid[32], flags[16]; GetCmdArg(1, sid, sizeof(sid));
    if (args >= 2) GetCmdArg(2, flags, sizeof(flags)); else strcopy(flags, sizeof(flags), DEF_FLAGS);
    if (g_authed.FindString(sid) == -1) g_authed.PushString(sid);
    SaveState();
    for (int c = 1; c <= MaxClients; c++) if (IsClientInGame(c) && !IsFakeClient(c) && IsAuthed(c)) GrantFlags(c, flags);
    return Plugin_Handled;
}
// Cmd_Revoke / Cmd_Clear / Cmd_List / Cmd_Reload: análogos (quitar del set, RemoveUserAdmin al revocar, SaveState).
```

### 5.4 Instalación (tareas en `fleet.yml`)

1. Copiar `fleet_admin.smx` junto a los otros custom plugins (extender el `loop` existente de la
   tarea *"Install custom SourceMod plugins (compiled)"*):

   ```yaml
   loop:
     - admin_manager.smx
     - idle_hibernate.smx
     - chat_logger.smx
     - fleet_admin.smx          # <-- NUEVO
   ```

2. Copiar la fuente `fleet_admin.sp` (extender el `loop` de *"Install custom plugin sources"*).

3. Crear el directorio de estado (owner `steam`, para que el server escriba):

   ```yaml
   - name: Crear el directorio de estado del fleet (admins por-servidor)
     ansible.builtin.file:
       path: "{{ install_dir }}/left4dead2/addons/sourcemod/data/l4d2fleet"
       state: directory
       owner: "{{ steam_user }}"
       group: "{{ steam_user }}"
       mode: "0775"
   ```

### 5.5 Reservarlo en el unloader parcheado (OBLIGATORIO)

Durante un match, confogl dispara `pred_unload_plugins` y descarga **todos** los plugins no
reservados. Si `fleet_admin` se descarga a mitad de match, el reservador **pierde su admin**.
Por eso se agrega a la lista blanca de `predictable_unloader.sp`:

```sourcepawn
char gKeep[][] =
{
    "chat_logger.smx",
    "admin_manager.smx",
    "idle_hibernate.smx",
    "fleet_admin.smx"        // <-- NUEVO
};
```

Recompilar con `spcomp predictable_unloader.sp` y commitear el `.smx` (mismo flujo que los demás).
La tarea *"Install the patched plugin unloader"* de `fleet.yml` ya lo despliega sobre la copia de
ZoneMod después del sync — no hay que tocar esa tarea.

> El agente **no** habla con `fleet_admin` por filesystem (permisos cross-user), sino por **RCON**
> (§7.5): `sm_fleet_clear` + `sm_fleet_grant <steamid64>` al entregar un server. El plugin es el
> único que escribe su archivo de estado.

---

## 6. MariaDB + SourceBans++ + panel PHP (`tasks/sourcebans.yml`)

### 6.1 Paquetes y servicios

```yaml
- name: Instalar MariaDB, nginx, PHP-FPM y extensiones para SourceBans++
  ansible.builtin.apt:
    name:
      - mariadb-server
      - mariadb-client
      - python3-pymysql        # requerido por community.mysql
      - nginx
      - php-fpm
      - php-mysql
      - php-mbstring
      - php-gd
      - php-curl
      - php-xml
      - php-zip
      - php-intl
      - unzip
    update_cache: true
    state: present

- name: Asegurar MariaDB arrancada
  ansible.builtin.systemd: { name: mariadb, enabled: true, state: started }
```

### 6.2 Base de datos y usuario (módulo `community.mysql`)

MariaDB en Ubuntu autentica `root` por **unix_socket**, así que no hace falta password de root:

```yaml
- name: Crear la base de datos de SourceBans
  community.mysql.mysql_db:
    name: "{{ sb_db_name }}"
    encoding: utf8mb4
    collation: utf8mb4_unicode_ci
    state: present
    login_unix_socket: /run/mysqld/mysqld.sock

- name: Crear el usuario de SourceBans (panel + plugin del juego, ambos localhost)
  community.mysql.mysql_user:
    name: "{{ sb_db_user }}"
    password: "{{ sb_db_password }}"          # vault
    host: localhost
    priv: "{{ sb_db_name }}.*:ALL"
    state: present
    login_unix_socket: /run/mysqld/mysqld.sock
  no_log: true
```

Un **solo** usuario (`sbpp@localhost`) lo usan tanto el panel PHP como el plugin SourceBans++ del
juego (ambos conectan a `127.0.0.1:3306`). LAC no conecta a MySQL directamente: banea a través del
plugin SourceBans++ (ver §6.6). Suficiente para hobby; no se separan roles.

### 6.3 Esquema — decisión pragmática (no sobre-automatizar)

SourceBans++ crea su esquema (tablas `sb_*`, settings y el **primer admin del panel**) con su
**instalador web**. Automatizarlo entero por Ansible es frágil (genera hashes, settings, servers).
Decisión: **Ansible deja la DB vacía + usuario + archivos + config**, y el esquema/primer-admin se
crean **una sola vez** por el instalador web desde la LAN:

1. Tras el primer `ansible-playbook`, abrir `http://192.168.18.100:{{ sb_web_listen }}/install/`.
2. Completar el wizard (usa `sbpp@localhost` / `sb_db_password`, host `127.0.0.1`).
3. Crear el admin del panel (operador).
4. Borrar/proteger el directorio `install/` (tarea Ansible idempotente que lo elimina si existe,
   ver 6.5).

Es un paso manual **una vez**; el resto es idempotente. (Alternativa documentada pero **no**
recomendada: importar `sql/sourcebans-*.sql` del release con `mysql_db state=import` y sembrar el
admin por SQL — más código para mantener por cada versión de SB++.)

### 6.4 Descarga del panel PHP

```yaml
- name: Descargar el release del panel SourceBans++
  ansible.builtin.get_url:
    url: "https://github.com/sbpp/sourcebans-pp/releases/download/{{ sourcebans_pp_version }}/sourcebans-pp-{{ sourcebans_pp_version }}.tar.gz"
    dest: "/opt/l4d2-fleet/sourcebans-pp-{{ sourcebans_pp_version }}.tar.gz"
    mode: "0644"

- name: Desplegar los archivos del panel
  ansible.builtin.unarchive:
    src: "/opt/l4d2-fleet/sourcebans-pp-{{ sourcebans_pp_version }}.tar.gz"
    dest: "{{ sb_web_root }}"
    remote_src: true
    owner: www-data
    group: www-data
    creates: "{{ sb_web_root }}/index.php"
```

(El tar del release trae el árbol web en la raíz; ajustar `extra_opts: [--strip-components=N]` según
el layout del release — en 1.8.x el web vive bajo `upload/`, así que `--strip-components` o apuntar
`dest` al subdirectorio correcto. Verificar al implementar.)

### 6.5 Config del panel + nginx + limpieza del instalador

`templates/sourcebans.config.php.j2` (credenciales desde vault; SB++ igualmente guarda su config,
pero pre-sembrarla evita re-teclear):

```php
<?php // Managed by Ansible
$config = [
  'host' => '{{ sb_db_host }}', 'port' => {{ sb_db_port }},
  'db' => '{{ sb_db_name }}', 'user' => '{{ sb_db_user }}',
  'pass' => '{{ sb_db_password }}', 'prefix' => 'sb',
];
```

`templates/nginx-sourcebans.conf.j2`:

```nginx
server {
    listen 127.0.0.1:{{ sb_web_listen }};     # y/o la IP LAN si CloudFront llega por DDNS al puerto forwarded
    server_name _;
    root {{ sb_web_root }};
    index index.php;

    access_log /var/log/nginx/sourcebans_access.log;   # el agente lo lee para el sostén #3 (§7.4)

    location / { try_files $uri $uri/ /index.php?$args; }
    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php-fpm.sock;        # ajustar a la versión: php8.3-fpm.sock
    }
}
```

```yaml
- name: Instalar el server block de SourceBans en nginx
  ansible.builtin.template:
    src: nginx-sourcebans.conf.j2
    dest: /etc/nginx/sites-available/sourcebans.conf
    mode: "0644"
  notify: restart nginx

- name: Habilitar el site
  ansible.builtin.file:
    src: /etc/nginx/sites-available/sourcebans.conf
    dest: /etc/nginx/sites-enabled/sourcebans.conf
    state: link
  notify: restart nginx

- name: Instalar la config del panel
  ansible.builtin.template:
    src: sourcebans.config.php.j2
    dest: "{{ sb_web_root }}/config.php"
    owner: www-data
    group: www-data
    mode: "0640"
  no_log: true

- name: Quitar el instalador web tras el setup inicial (idempotente)
  ansible.builtin.file:
    path: "{{ sb_web_root }}/install"
    state: absent
  when: sb_installer_done | default(false) | bool   # ponerlo en true tras el wizard
```

> **Wake-on-uso solo-operador** (D13): lo hace la **nube** (CloudFront/Lambda verifica sesión con
> flag `operador` antes de proxear `/sourcebans` y dispara WoL). nginx local **no** filtra — confía
> en que la nube ya autorizó. **Supuesto sobre el dominio nube** (§11). El panel solo responde con
> la PC encendida (necesita MySQL local) — consecuencia aceptada (D13).

### 6.6 Plugin SourceBans++ del juego + LAC persistente

El release de SB++ trae los plugins del lado juego. Se despliegan al game tree y se plantilla el
`databases.cfg`:

```yaml
- name: Desplegar los plugins SourceBans++ del juego
  ansible.builtin.copy:
    src: "sourcebans-plugins/{{ item }}"           # extraídos del release a files/ (o del tar)
    dest: "{{ install_dir }}/left4dead2/addons/sourcemod/plugins/{{ item }}"
    owner: "{{ steam_user }}"
    group: "{{ steam_user }}"
    mode: "0644"
  loop:
    - sourcebans.smx
    - sb_admins.smx
    - sbpp_checker.smx        # ajustar al set del release usado

- name: Configurar databases.cfg -> MySQL local (después del copy de ZoneMod)
  ansible.builtin.template:
    src: databases.cfg.j2
    dest: "{{ install_dir }}/left4dead2/addons/sourcemod/configs/databases.cfg"
    owner: "{{ steam_user }}"
    group: "{{ steam_user }}"
    mode: "0640"
  no_log: true
```

`templates/databases.cfg.j2` (Ansible-managed → se regenera en cada run tras el copy; **no**
necesita el backup/restore de §4 porque no muta en runtime):

```
"Databases"
{
    "default"
    {
        "driver"    "sqlite"
        "database"  "sourcemod-local"
    }
    "storage-local"
    {
        "driver"    "sqlite"
        "database"  "sourcemod-local"
    }
    "sourcebans"
    {
        "driver"    "mysql"
        "host"      "{{ sb_db_host }}"
        "database"  "{{ sb_db_name }}"
        "user"      "{{ sb_db_user }}"
        "pass"      "{{ sb_db_password }}"
        "port"      "{{ sb_db_port }}"
    }
}
```

**LAC → SourceBans:** LAC (lilac) ya viene con ZoneMod y ya tiene `lilac_sourcebans 1` /
`lilac_ban_length 0`; hoy "banea a la nada" por falta de DB. Con SB++ instalado, los bans persisten
solos. Se **reafirman** los convars vía `lineinfile` en `server.cfg` (idempotente, corre en cada
boot; extender la lista de la tarea *"public-server toggles"* o una tarea nueva en `sourcebans.yml`):

```yaml
- name: Reafirmar los convars de LAC -> SourceBans en server.cfg
  ansible.builtin.lineinfile:
    path: "{{ install_dir }}/left4dead2/cfg/server.cfg"
    regexp: "^{{ item.key }} "
    line: '{{ item.key }} "{{ item.value }}"'
  loop:
    - { key: lilac_sourcebans, value: "1" }
    - { key: lilac_ban_length, value: "0" }
```

> LAC no está en el repo `l4d2-fleet` (llega con ZoneMod), por eso solo aseguramos convars +
> instalamos SB++; no se toca la instalación de lilac.

### 6.7 Handlers nuevos (`handlers/main.yml`)

```yaml
- name: restart mariadb
  ansible.builtin.systemd: { name: mariadb, state: restarted }
- name: restart nginx
  ansible.builtin.systemd: { name: nginx, state: restarted }
- name: restart php-fpm
  ansible.builtin.systemd: { name: "{{ php_fpm_service | default('php8.3-fpm') }}", state: restarted }
- name: restart l4d2-agent
  ansible.builtin.systemd: { name: l4d2-agent, state: restarted }
```

---

## 7. El agente (`tasks/agent.yml`)

### 7.1 Usuario de servicio y sudoers scoped

El agente **no** corre como root. Usuario de sistema `l4d2agent`, sin login, con privilegios
mínimos vía un **wrapper root** (más seguro que globbing en sudoers).

```yaml
- name: Crear el usuario del agente
  ansible.builtin.user:
    name: "{{ agent_user }}"
    system: true
    shell: /usr/sbin/nologin
    home: "{{ agent_home }}"
    create_home: true
    groups: adm            # 'adm' -> leer /var/log/nginx/sourcebans_access.log (sostén #3)
    append: true

- name: Instalar el wrapper de control (root, no editable por el agente)
  ansible.builtin.copy:
    src: fleetctl
    dest: /opt/l4d2-fleet/fleetctl
    owner: root
    group: root
    mode: "0755"

- name: sudoers scoped para el agente
  ansible.builtin.template:
    src: sudoers-l4d2agent.j2
    dest: /etc/sudoers.d/l4d2agent
    mode: "0440"
    validate: "visudo -cf %s"
```

`templates/sudoers-l4d2agent.j2`:

```
# El agente solo puede invocar el wrapper; el wrapper valida N y la acción.
{{ agent_user }} ALL=(root) NOPASSWD: /opt/l4d2-fleet/fleetctl
```

`files/fleetctl` (bash root-owned; valida y traduce a systemctl/poweroff — el agente **no** puede
pasar comandos arbitrarios):

```bash
#!/usr/bin/env bash
set -euo pipefail
action="${1:-}"; arg="${2:-}"
case "$action" in
  start|stop|restart)
    [[ "$arg" =~ ^[0-9]+$ ]] || { echo "N inválido"; exit 2; }
    (( arg >= 1 && arg <= 16 )) || { echo "N fuera de rango"; exit 2; }   # tope duro > server_count
    exec /usr/bin/systemctl "$action" "l4d2@${arg}.service" ;;
  poweroff)
    exec /usr/bin/systemctl poweroff ;;
  *) echo "uso: fleetctl {start|stop|restart <N>|poweroff}"; exit 2 ;;
esac
```

Superficie de escalación del agente = exactamente {arrancar/parar/reiniciar `l4d2@1..16`,
`poweroff`}. Nada más. El wrapper es root:root 0755 (no escribible por `l4d2agent`).

### 7.2 venv y dependencias

```yaml
- name: Crear el venv del agente
  ansible.builtin.command: "python3 -m venv {{ agent_home }}/venv"
  args: { creates: "{{ agent_home }}/venv/bin/python" }

- name: Dependencias del agente
  ansible.builtin.pip:
    name: [requests]
    virtualenv: "{{ agent_home }}/venv"
```

Solo `requests` (HTTPS saliente). RCON y A2S son sockets de stdlib (§7.5, §8) — sin más deps.

### 7.3 Código, env y unit

```yaml
- name: Instalar el agente y el cliente RCON
  ansible.builtin.copy:
    src: "agent/{{ item }}"
    dest: "{{ agent_home }}/{{ item }}"
    owner: "{{ agent_user }}"
    group: "{{ agent_user }}"
    mode: "0755"
  loop: [agent.py, rcon.py]

- name: Instalar el env del agente (token + config)
  ansible.builtin.template:
    src: agent.env.j2
    dest: /etc/l4d2-fleet/agent.env
    owner: root
    group: "{{ agent_user }}"
    mode: "0640"
  no_log: true
  notify: restart l4d2-agent

- name: Instalar la unit del agente
  ansible.builtin.template:
    src: l4d2-agent.service.j2
    dest: /etc/systemd/system/l4d2-agent.service
    mode: "0644"
  notify: [reload systemd, restart l4d2-agent]

- name: Arrancar y habilitar el agente
  ansible.builtin.systemd: { name: l4d2-agent, enabled: true, state: started, daemon_reload: true }
```

`templates/agent.env.j2` (el token **no** está en el repo; sale de la var vault):

```bash
# Managed by Ansible. Do not edit by hand.
PANEL_API_BASE={{ panel_api_base }}
AGENT_DEVICE_TOKEN={{ agent_device_token }}
POLL_INTERVAL={{ agent_poll_interval }}
EMPTY_GRACE={{ agent_empty_grace }}
SOURCEBANS_GRACE={{ agent_sourcebans_grace }}
PORT_BASE={{ port_base }}
SERVER_COUNT={{ server_count }}
GAME_IP={{ game_ip }}
RCON_ADDR=127.0.1.1
RCON_PASSWORD={{ rcon_password }}
SOURCEBANS_ACCESS_LOG=/var/log/nginx/sourcebans_access.log
```

> **RCON_PASSWORD también aquí:** así el agente no necesita leer `fleet.env` (0640 `steam:steam`)
> ni entrar al grupo `steam`. Se duplica el secreto en dos archivos Ansible-managed con permisos
> estrictos — aceptable y menos privilegio que meter al agente en el grupo `steam`.

`templates/l4d2-agent.service.j2`:

```ini
[Unit]
Description=L4D2 Panel agent (polling saliente + control local)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={{ agent_user }}
Group={{ agent_user }}
EnvironmentFile=/etc/l4d2-fleet/agent.env
Environment=PYTHONPATH=/opt/l4d2-fleet
ExecStart={{ agent_home }}/venv/bin/python {{ agent_home }}/agent.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`PYTHONPATH=/opt/l4d2-fleet` deja importar el módulo A2S compartido (§8).

### 7.4 Bucle del agente y sostenes (pseudocódigo)

```python
# agent.py  (resumen)
import os, time, subprocess, requests
from a2s import query, primary_ip           # módulo compartido (§8)
from rcon import RconClient

API   = os.environ["PANEL_API_BASE"].rstrip("/")
TOKEN = os.environ["AGENT_DEVICE_TOKEN"]
IP    = os.environ.get("GAME_IP") or primary_ip()
PB    = int(os.environ["PORT_BASE"]); N = int(os.environ["SERVER_COUNT"])
SERVERS = {n: PB + n for n in range(1, N + 1)}
EMPTY_GRACE = int(os.environ["EMPTY_GRACE"]); SB_GRACE = int(os.environ["SOURCEBANS_GRACE"])
empty_since = {}                              # slot -> epoch en que quedó vacío

def rcon(slot, cmd):
    return RconClient(os.environ["RCON_ADDR"], SERVERS[slot],
                      os.environ["RCON_PASSWORD"]).exec(cmd)

def fleetctl(*args): subprocess.run(["sudo", "/opt/l4d2-fleet/fleetctl", *args], check=True)

def collect():
    slots = []
    for slot, port in SERVERS.items():
        a = query(IP, port)                   # {'up',...,'players','map'} o {'up':0}
        active = subprocess.run(["systemctl","is-active","--quiet",f"l4d2@{slot}"]).returncode == 0
        humans = a.get("players", 0) - a.get("bots", 0) if a["up"] else 0
        if active and humans == 0: empty_since.setdefault(slot, time.time())
        else: empty_since.pop(slot, None)
        slots.append({"slot":slot,"port":port,"active":active,"up":a["up"],
                      "players":a.get("players",0),"bots":a.get("bots",0),
                      "map":a.get("map",""), "empty_secs": int(time.time()-empty_since[slot]) if slot in empty_since else None})
    return slots

def sourcebans_recent():
    try: return (time.time() - os.path.getmtime(os.environ["SOURCEBANS_ACCESS_LOG"])) < SB_GRACE
    except OSError: return False

def ssh_operator_active():
    out = subprocess.run(["who"], capture_output=True, text=True).stdout
    return any(l for l in out.splitlines())   # afinar: excluir la sesión del agente si aplica

def public_ip():
    try: return requests.get("https://checkip.amazonaws.com", timeout=5).text.strip()
    except Exception: return None

while True:
    slots = collect()
    payload = {"slots": slots, "public_ip": public_ip(),
               "sourcebans_recent": sourcebans_recent(), "ssh_operator": ssh_operator_active()}
    r = requests.post(f"{API}/api/agent/heartbeat", json=payload,
                      headers={"Authorization": f"Bearer {TOKEN}"}, timeout=10)
    data = r.json() if r.ok else {}
    for cmd in data.get("commands", []):
        handle(cmd)                            # §7.5
    # ---- Auto-apagado por sostenes (D11 / §7 de la spec) ----
    hold_cloud = data.get("hold_poweroff", False)          # sostén #2: intent/cola activos (lo sabe la nube)
    holds = [
        any(s["players"] - s["bots"] > 0 or (s["empty_secs"] is not None and s["empty_secs"] < EMPTY_GRACE)
            for s in slots if s["active"]),    # #1 server con jugadores o vacío < 15 min
        hold_cloud,                            # #2 encendido/reserva en curso
        sourcebans_recent(),                   # #3 SourceBans usado < 10 min
        ssh_operator_active(),                 # #4 sesión SSH del operador
    ]
    # Cerrar servers vacíos que pasaron el grace (D11) — libera el sostén #1 gradualmente:
    for s in slots:
        if s["active"] and s["empty_secs"] is not None and s["empty_secs"] >= EMPTY_GRACE:
            rcon(s["slot"], "sm_fleet_clear"); fleetctl("stop", str(s["slot"]))
    if not any(holds):
        fleetctl("poweroff")                   # apagado limpio inmediato
    time.sleep(int(os.environ["POLL_INTERVAL"]))
```

**División de responsabilidad del apagado:** los sostenes **1, 3, 4** los evalúa el agente
localmente (tiene A2S, el access log de nginx, `who`); el sostén **2** (intent/encendido/cola en
curso) lo sabe la **nube** y lo comunica como `hold_poweroff` en la respuesta del heartbeat. Cuando
**ninguno** aplica → `fleetctl poweroff`. Como cada server vacío ya esperó su grace de 15 min antes
de cerrarse, apagar en cuanto todo está cerrado **no** produce flapping (D11).

### 7.5 Comandos que ejecuta el agente

| Comando de la nube | Acción del agente |
|---|---|
| `open_server {slot, steamid64, map?}` | `fleetctl restart <slot>` (arranca limpio) → esperar A2S `up` (poll `query`, timeout ~45s) → RCON `sm_fleet_clear` + `sm_fleet_grant <steamid64>` → (opcional `changelevel <map>`) → reportar `steam://connect/<ip>:<port>` en el heartbeat |
| `close_server {slot}` | RCON `sm_fleet_clear` → `fleetctl stop <slot>` |
| `kick {slot, steamid}` | RCON `sm_kick` / por userid resuelto con `status` |
| `changemap {slot, map}` | RCON `changelevel <map>` |
| `rematch {slot}` | watchdog de matchmode (§7.7) |
| `poweroff` | `fleetctl poweroff` (además de la lógica de sostenes propia) |

El cliente RCON (`files/agent/rcon.py`) es un **Source RCON TCP** mínimo (~60 líneas): conecta a
`127.0.1.1:<port>` (RCON bindea a `127.0.1.1`, no `127.0.0.1`), hace `SERVERDATA_AUTH` con
`RCON_PASSWORD` y `SERVERDATA_EXECCOMMAND`. Sin dependencias externas.

### 7.6 Arranque de las units con el panel activo

Hoy `fleet.yml` hace `enabled: true, state: started` para `l4d2@1..N`. Con el panel, quien gobierna
qué server corre es el **agente**, no systemd. Si al boot systemd arranca N servers vacíos, el
agente esperaría 15 min de grace tras cada WoL antes de poder apagar — desperdicio. Ajuste:

```yaml
- name: Instalar/actualizar las units (siempre)
  ansible.builtin.systemd:
    name: "l4d2@{{ item }}"
    enabled: "{{ not (with_agent | bool) }}"      # con agente: NO auto-arrancar al boot
    state: "{{ 'started' if not (with_agent | bool) else 'stopped' }}"
    daemon_reload: true
  loop: "{{ range(1, server_count | int + 1) | list }}"
```

Con `with_agent: true`, las units quedan instaladas pero **detenidas y sin enable**; el agente las
arranca on-demand al recibir `open_server`. Sin panel (`with_agent: false`) el comportamiento
actual se conserva.

### 7.7 Watchdog del churn de matchmode → **en el agente** (no timer systemd)

Bug conocido: `!match`/`!unmatch` se traban en servers vacíos (candado de confogl + timers
congelados por hibernación). Decisión: **el watchdog vive en el agente**, no en un timer systemd
aparte, porque el agente ya corre siempre que la PC está encendida y ya tiene el cliente RCON y el
estado A2S — un timer separado duplicaría ambos.

Dos capas:

1. **Prevención (barata, elimina el bug de raíz):** al liberar un slot, el agente hace
   `fleetctl restart <slot>` en `open_server`/`close_server` → cada reserva estrena un proceso
   limpio, sin candado de confogl heredado. En la práctica esto ya evita el estado "match trabado".
2. **Watchdog de respaldo:** en cada ciclo, si un slot está `active`, con 0 humanos y lleva vacío
   `> ~120s` reportando estado de match colgado, el agente manda RCON `sm_unmatch` (o `!unmatch`);
   si sigue anómalo tras otro ciclo, `fleetctl restart <slot>`. Es idempotente y barato.

---

## 8. Reuso de la lógica A2S → **módulo compartido** `a2s.py`

El exporter (`l4d2_exporter.py`) ya tiene el parseo A2S correcto (challenge `0x41`, `S2A_INFO`
`0x49`). El agente necesita **exactamente** lo mismo. Decisión: **extraer a un módulo compartido**,
no duplicar — es el único código con protocolo binario delicado; dos copias divergen.

`files/a2s.py` (stdlib pura; funciona con el python3 del sistema del exporter **y** con el venv del
agente):

```python
import socket

def primary_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.connect(("8.8.8.8", 80)); return s.getsockname()[0]
    except Exception: return "127.0.0.1"
    finally: s.close()

A2S_INFO = b"\xFF\xFF\xFF\xFF\x54Source Engine Query\x00"

def query(ip: str, port: int) -> dict:
    """Info A2S de una instancia, o {'up': 0} si no responde. (Antes vivía en el exporter.)"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    try:
        s.sendto(A2S_INFO, (ip, port)); data, _ = s.recvfrom(4096)
        if data[4:5] == b"\x41":
            s.sendto(A2S_INFO + data[5:9], (ip, port)); data, _ = s.recvfrom(4096)
        if data[4:5] == b"\x49":
            rest = data[6:]
            def rs(b):
                i = b.index(0); return b[:i].decode("utf-8","replace"), b[i+1:]
            _n, rest = rs(rest); mapn, rest = rs(rest); _f, rest = rs(rest); _g, rest = rs(rest)
            return {"up":1,"players":rest[2],"max":rest[3],"bots":rest[4],"map":mapn}
    except Exception: pass
    finally: s.close()
    return {"up": 0}
```

**Cambio mínimo en `l4d2_exporter.py`** (mantiene `GAME_IP` global, delega el resto):

```python
# elimina primary_ip() y query() locales; en su lugar:
from a2s import query as a2s_query, primary_ip
GAME_IP = os.environ.get("GAME_IP") or primary_ip()
# ... y donde antes llamaba query(port):
m = a2s_query(GAME_IP, port)
```

Tarea Ansible en `monitoring.yml` (o `fleet.yml`) para desplegar el módulo junto al exporter:

```yaml
- name: Instalar el módulo A2S compartido
  ansible.builtin.copy: { src: a2s.py, dest: /opt/l4d2-fleet/a2s.py, mode: "0755" }
  notify: restart l4d2-exporter
```

Ambos scripts viven bajo `/opt/l4d2-fleet/`: el exporter (`ExecStart .../l4d2_exporter.py`) tiene
ese dir en `sys.path[0]` → `import a2s` funciona; el agente lo obtiene por
`PYTHONPATH=/opt/l4d2-fleet` en su unit (§7.3). El refactor del exporter se valida en el mismo run
(si el `import` falla, el handler `restart l4d2-exporter` deja la unit caída → visible al instante).

> Dos consultores A2S al mismo srcds (exporter ~cada scrape + agente cada `POLL_INTERVAL`) son
> triviales para el servidor: A2S es sin estado y admite múltiples clientes.

---

## 9. DNS dinámico

CloudFront debe alcanzar la PC (IP pública cambiante) para `/sourcebans`. Dos modos, seleccionados
por `ddns_mode`:

### 9.1 `ddns_mode: cloud` (RECOMENDADO — sin credenciales AWS en casa)

El agente ya reporta `public_ip` en cada heartbeat (§7.4). La **Lambda de heartbeat** compara con
el valor actual del registro Route53 `origin-sb.ventrax.dev` (zona `Z0798505KCA3V0GU54OJ`) y lo
actualiza si cambió (`ChangeResourceRecordSets`). **Ventaja:** las credenciales AWS viven solo en
la nube; la PC nunca guarda llaves AWS. **Cero tareas Ansible extra** — es parte del agente.
**Supuesto sobre el dominio nube/lambdas** (§11): la Lambda tiene permiso IAM sobre ese único
record y hace el upsert.

### 9.2 `ddns_mode: local` (alternativa, si se prefiere no darle Route53 a la nube)

Script + timer systemd en la PC, con credenciales AWS **scoped** (política que solo permite
`route53:ChangeResourceRecordSets` sobre esa zona). Tareas:

```yaml
- name: (DDNS local) Instalar el actualizador
  ansible.builtin.copy: { src: ddns.sh, dest: /opt/l4d2-fleet/ddns.sh, mode: "0755" }
  when: ddns_mode == 'local'

- name: (DDNS local) Credenciales AWS scoped
  ansible.builtin.template:
    src: ddns-route53.env.j2
    dest: /etc/l4d2-fleet/ddns.env
    owner: root
    mode: "0600"
  no_log: true
  when: ddns_mode == 'local'

- name: (DDNS local) Timer systemd (cada 5 min)
  # unit + timer que corren ddns.sh con EnvironmentFile=/etc/l4d2-fleet/ddns.env
  when: ddns_mode == 'local'
```

`ddns.sh` detecta la IP (`curl -s https://checkip.amazonaws.com`) y hace el upsert vía `aws cli`
(o `curl` firmado). Solo corre con la PC encendida (que es cuando importa). **Recomendación firme:
usar `cloud`** para no poner llaves AWS en una PC doméstica.

---

## 10. Impacto sobre el monitoreo existente (Prometheus / Grafana / Loki)

Principio: **no romper lo que hay**. El exporter, Prometheus, node_exporter, Loki, Promtail y
Grafana siguen igual. Cambios mínimos y aditivos:

### 10.1 Logs del agente → Loki (útil, barato)

El scrape de Promtail hoy filtra **solo** `l4d2@N`. Agregar un job para la unit del agente (y
opcional nginx de SourceBans) en `templates/promtail.yml.j2`:

```yaml
  - job_name: l4d2_agent
    journal:
      max_age: 12h
      path: /var/log/journal
      labels: { job: l4d2_agent }
    relabel_configs:
      - source_labels: ['__journal__systemd_unit']
        regex: 'l4d2-agent\.service'
        action: keep
```

Así el operador ve en Grafana (Explore) `{{'{'}}job="l4d2_agent"{{'}'}}`: heartbeats, comandos
ejecutados, powerons, decisiones de apagado. MariaDB/nginx/php **no** se instrumentan (no crítico
para hobby; node_exporter ya cubre CPU/RAM/red del host).

### 10.2 Métricas: reusar A2S, sin exporter nuevo

El agente **no** expone métricas Prometheus (haría falta un puerto y un scrape más). El estado de
reservas/PC vive en **DynamoDB** (la nube), no en Prometheus local. El exporter A2S existente ya
da players/map/up por server, que es lo que el dashboard necesita. **No se añade exporter.**

### 10.3 Gaps por auto-apagado (comportamiento esperado, no bug)

Cuando el agente apaga la PC, **Prometheus/Grafana/Loki se apagan con ella**. Consecuencias que hay
que aceptar/documentar:

- Series con **huecos** mientras la PC está apagada — normal en este diseño.
- Cualquier alerta tipo "target down" / "instance down" es **ruido** (la PC apagada es el estado
  esperado). Recomendación: **no** configurar alertas de disponibilidad, o silenciarlas. El
  monitoreo es LAN-only y sirve para diagnóstico cuando la PC está encendida, no para uptime.
- El dashboard "L4D2 Fleet" sigue funcionando; opcionalmente se añade una fila "Panel" (logs del
  agente vía Loki). Es *nice-to-have*, **no bloqueante** para v1.

### 10.4 Puertos nuevos

| Servicio | Bind | ¿Público? |
|---|---|---|
| MariaDB | `127.0.0.1:3306` | No (solo localhost) |
| php-fpm | socket unix | No |
| nginx (SourceBans) | `127.0.0.1:{{ sb_web_listen }}` (+ puerto forwarded para CloudFront/DDNS) | Sí, solo `/sourcebans` vía CloudFront |
| Agente | solo saliente HTTPS | No abre puertos entrantes |

El resto del stack de monitoreo permanece **LAN-only** como hoy.

---

## 11. Supuestos sobre otros dominios (nube / lambdas / DNS)

1. **API de heartbeat** existe en `{{ panel_api_base }}/api/agent/heartbeat`, autentica por
   `Authorization: Bearer <agent_device_token>`, recibe el payload de §7.4 y responde
   `{commands:[...], hold_poweroff:bool}`.
2. La nube **emite** los comandos `open_server`/`close_server`/`kick`/`changemap`/`rematch`/
   `poweroff` con el shape de §7.5 (en particular `open_server` trae `steamid64`).
3. El sostén **#2** (intent/encendido/cola en curso) lo decide la nube y lo comunica como
   `hold_poweroff: true`. El agente no conoce intents ni la cola.
4. El **WoL** lo dispara una Lambda (magic packet UDP a la IP pública, MAC `0A:E0:AF:AF:28:22`).
   El agente solo reporta `public_ip` para que la nube sepa a dónde y para el DDNS.
5. **Wake-on-uso de `/sourcebans` restringido al operador** lo verifica CloudFront/Lambda (sesión
   con flag `operador`) **antes** de proxear al origen. nginx local no filtra.
6. **DDNS modo cloud:** la Lambda de heartbeat actualiza el registro `origin-sb.ventrax.dev` en
   Route53 (zona `Z0798505KCA3V0GU54OJ`) con la IP reportada.
7. El **`agent_device_token`** lo genera el dominio nube (o se acuerda) y se coloca en el vault; el
   backend lo valida.
8. `panel_api_base` es la URL pública (CloudFront o Function URL) que la SPA/infra ya expone.
9. El **router de casa** forwardea el puerto que CloudFront usa como origen para `/sourcebans`
   (protocolo y TLS del lado casa los define el dominio nube; §6.5). Los puertos de juego UDP
   `port_base+1..port_base+server_count` (6033-6036) ya están forwardeados.

---

## 12. Decisiones de diseño (resumen) y riesgos

### Decisiones
- **Estado por-servidor en `data/l4d2fleet/`** (dir que ZoneMod no trae) → sobrevive al copy sin
  tocar `zonemod.yml`. `admins_simple.ini` se protege con backup/restore de 3 tasks.
- **Admin por-servidor = plugin `fleet_admin`** con admins en memoria por `hostport`; agente lo
  controla por **RCON** (no filesystem). Reservado en `gKeep` del unloader.
- **Agente en Python**, usuario `l4d2agent`, privilegios mínimos vía **wrapper `fleetctl` +
  sudoers**; token en `agent.env` (0640, desde vault); RCON pass duplicado ahí para no dar grupo
  `steam`.
- **A2S extraído a módulo compartido** `a2s.py` (exporter + agente); no duplicar.
- **Watchdog de matchmode en el agente**, con prevención por `restart` entre reservas.
- **DDNS modo cloud** (la nube maneja Route53) para no poner llaves AWS en casa.
- **SourceBans++: esquema/primer-admin por instalador web una vez**; Ansible hace DB/usuario/
  archivos/config/nginx/php. No sobre-automatizar.
- **Units no auto-arrancan al boot** con `with_agent` (el agente gobierna) → evita 15 min de grace
  desperdiciados por WoL.

### Riesgos
| Riesgo | Mitigación |
|---|---|
| El release de SB++ cambia de layout (`--strip-components`, set de `.smx`) | Verificar el tar al implementar; fijar `sourcebans_pp_version`; el setup web absorbe diferencias de esquema |
| El copy de ZoneMod **sí** trae `admins_simple.ini` y lo pisa | Backup/restore §4.2-B lo cubre; el reseed idempotente re-aplica group_vars |
| `who`/`loginctl` cuenta la propia sesión del agente como "SSH operador" | El agente corre como servicio (no vía SSH); afinar el filtro para excluir sesiones no-pty / el propio uid |
| RCON en `127.0.1.1` no responde si el hostname resuelve distinto | Confirmar bind en despliegue; `RCON_ADDR` es configurable en `agent.env` |
| PC apagada → alertas "target down" ruidosas | No configurar alertas de disponibilidad; monitoreo es diagnóstico LAN, no uptime |
| Credenciales AWS en casa (modo local) | Usar `ddns_mode: cloud`; si local, política IAM scoped a un solo record |
| Instalador web de SB++ queda expuesto | Tarea idempotente que borra `install/` tras el setup; nginx solo alcanzable por CloudFront/LAN |
| `fleetctl` con tope hardcodeado `16` desincronizado de `server_count` | El tope es una guarda de seguridad amplia; el agente solo pide slots válidos según `SERVER_COUNT` del env |

---

## 13. Checklist de implementación

- [ ] `defaults/main.yml`: variables §2.1 (+ `admins_ini`, `php_fpm_service`).
- [ ] `all.yml.sample`: bloque §2.2. Crear `group_vars/vault.yml` con los secretos.
- [ ] `zonemod.yml`: 3 tasks de backup/restore de `admins_simple.ini` (§4.2-B).
- [ ] `fleet.yml`: instalar `fleet_admin.smx`/`.sp`, crear `data/l4d2fleet/`, condicionar arranque
      de units (§7.6), convars lilac (o en sourcebans.yml).
- [ ] `predictable_unloader.sp`: agregar `"fleet_admin.smx"` a `gKeep`; recompilar `.smx`.
- [ ] `fleet_admin.sp`: implementar (§5.3), compilar `.smx`.
- [ ] `tasks/sourcebans.yml` + templates (`databases.cfg.j2`, `sourcebans.config.php.j2`,
      `nginx-sourcebans.conf.j2`) (§6).
- [ ] `tasks/agent.yml` + `files/agent/{agent.py,rcon.py}` + `files/fleetctl` + templates
      (`agent.env.j2`, `l4d2-agent.service.j2`, `sudoers-l4d2agent.j2`) (§7).
- [ ] `files/a2s.py` + refactor de `l4d2_exporter.py` + tarea de despliegue del módulo (§8).
- [ ] `monitoring.yml`/`promtail.yml.j2`: job `l4d2_agent` (§10.1).
- [ ] `main.yml`: imports de `sourcebans.yml` y `agent.yml` con `when` (§3).
- [ ] `handlers/main.yml`: `restart mariadb/nginx/php-fpm/l4d2-agent` (§6.7).
- [ ] Setup web de SourceBans++ una vez (§6.3) y `sb_installer_done: true`.
```
