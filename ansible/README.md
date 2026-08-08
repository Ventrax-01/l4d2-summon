# Provisión de la flota

Despliega y configura los servidores de Left 4 Dead 2 con ZoneMod: descarga el juego, instala
los plugins, genera la configuración de cada instancia y levanta las units de systemd. También
monta el stack de monitoreo (Prometheus, Grafana, Loki).

Se ejecuta **en la propia máquina que hospeda los servidores** (`localhost ansible_connection=local`),
no se empuja por SSH.

```bash
cd ansible
cp group_vars/all.yml.sample group_vars/all.yml   # y rellenarlo (ver abajo)
ansible-playbook playbook.yml --ask-become-pass
```

Añadir un servidor es cambiar `server_count` y volver a ejecutar: los puertos, los nombres y la
configuración por instancia se derivan solos.

---

## Dónde se configura cada cosa

Toda la configuración real vive en **`group_vars/all.yml`**, que está **ignorado por git a
propósito**: este repositorio es público y ahí van la contraseña de RCON y los SteamID de los
admins. La plantilla versionada es `group_vars/all.yml.sample`.

| Qué | Dónde |
|---|---|
| Nombre de los servidores, cantidad, modo de juego | `group_vars/all.yml` |
| Contraseña de RCON | `group_vars/all.yml` |
| **Admins globales** | `group_vars/all.yml` → clave `admins` |
| MOTD y banner | `roles/l4d2_fleet/files/*.local.html` (también ignorados) |
| Puertos, rutas, valores por defecto | `roles/l4d2_fleet/defaults/main.yml` (versionado) |

## Admins globales

Los admins se declaran en `group_vars/all.yml`:

```yaml
admins:
  - { steamid: "STEAM_1:0:00000000", flags: "99:z" }   # root
  - { steamid: "STEAM_1:1:11111111", flags: "50:cdef" }
```

Ansible los siembra en `admins_simple.ini`. **Son globales a toda la flota**, porque las cuatro
instancias comparten una sola instalación del juego: quien esté en esa lista es admin en todos
los servidores.

**Banderas** — se combinan: `z` root · `c` kick · `d` ban · `e` unban · `f` slay · `g` cambiar
mapa · `j` chat · `m` rcon. El número antes de los dos puntos es la **inmunidad** (mayor número,
más protegido de las acciones de otros admins).

Para obtener el SteamID de alguien conectado, `status` en la consola del servidor.

Tras editar la lista:

```bash
ansible-playbook playbook.yml --ask-become-pass --tags fleet
```

O, si el servidor está en marcha y no quieres esperar al cambio de mapa, recarga la caché por
RCON con `sm_reloadadmins` (el archivo se relee al instante, sin reiniciar ni desconectar a nadie).

> ### ⚠️ Importante: los admins añadidos en caliente se pierden
>
> Si agregas a alguien editando `admins_simple.ini` a mano o con `!admin add` dentro del juego,
> **ese cambio no sobrevive** a la siguiente ejecución del playbook: la tarea que despliega ZoneMod
> sobrescribe la carpeta `addons/` completa, y con ella el archivo de admins.
>
> Los admins que deban ser permanentes van **siempre** en `group_vars/all.yml`.

## Admins por servidor

Lo anterior da admin en **toda** la flota. El sistema de reservas necesita algo distinto —que
quien reserva sea admin solo en *su* servidor— y eso lo resolverá un plugin aparte
(`fleet_admin.sp`), todavía sin implementar. Ver
[`docs/tecnico/08-fleet-integracion.md`](../docs/tecnico/08-fleet-integracion.md).

## Estructura

```
ansible/
├── playbook.yml
├── inventory.ini
├── ansible.cfg
├── group_vars/
│   ├── all.yml.sample      # plantilla versionada
│   └── all.yml             # configuración real (ignorada por git)
└── roles/l4d2_fleet/
    ├── tasks/              # dependencias, juego, zonemod, flota, monitoreo
    ├── templates/          # unit de systemd, fleet.env, promtail, loki
    ├── files/              # launcher, exporter, plugins propios, MOTD
    └── defaults/main.yml   # valores por defecto (versionado)
```

Documentación de detalle en [`docs/`](docs/).
