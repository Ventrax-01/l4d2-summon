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

Lo anterior da admin en **toda** la flota, porque `admins_simple.ini` pertenece al install de
SourceMod que los cuatro servidores comparten. Para que quien reserva mande solo en *su*
servidor hace falta otra cosa: el plugin `summon_admin.sp`, que va en el rol `summon_agent`.

Mantiene el permiso en memoria del proceso —nace cuando la nube lo pide por RCON y muere con
el servidor—, así que no toca ningún archivo y no hay nada que limpiar después. Los permisos
son cortos a propósito: echar a alguien, cambiar de mapa y votar. **No incluye banear**: un
ban sobreviviría a la reserva y le caería al siguiente que use ese servidor.

## Conectar con la plataforma (rol `summon_agent`)

Opcional. Sin él la flota funciona igual, solo que sin reservas: los cuatro servidores
encendidos todo el tiempo y administrados a mano.

Con él, la máquina se comporta como un recurso bajo demanda. El agente pregunta a la nube
cada 15 segundos, le cuenta lo que ve de cada servidor y ejecuta lo que le manden: levantar
un servidor para quien lo reservó, pararlo al terminar, o apagar la máquina cuando ya no la
sostiene nadie. La conversación va **siempre saliendo**, así que no hay que abrir ningún
puerto en casa.

Para activarlo, en `group_vars/all.yml`:

```yaml
with_summon: true
summon_token: "..."   # el valor está en el Parameter Store, /l4d2-summon/agent-token
```

Y desplegar como siempre: `ansible-playbook playbook.yml`.

### El router tiene que saber despertar la máquina

Esto no se configura desde el repo y sin ello el sistema no funciona: la plataforma apaga la
máquina y luego no puede volver a encenderla.

La Lambda de encendido manda el paquete mágico a la IP pública de casa, y el router lo tiene
que reenviar al equipo. **Con el equipo apagado el router no siempre sabe a qué tarjeta
entregarlo, y entonces lo tira.** Justo cuando hace falta.

Medido en esta instalación, en 11 intentos: **funciona una de cada tres o cuatro veces**. No
es un umbral de tiempo — hubo aciertos a los 66 s de apagarse y también tras varias horas, y
fallos en ambos extremos. Es sencillamente poco fiable.

Lo que sí está descartado:

- **La tarjeta y la BIOS.** Desde la LAN, mandando a la difusión, despierta **siempre**.
- **Que los paquetes no salgan o no lleguen a la red.** Con el equipo encendido se ven entrar
  por `udp/9` los cuatro que manda la Lambda.
- **Que sea cuestión de insistir.** El barrido manda un paquete por minuto; en los intentos
  fallidos no despertó con ninguno.

Encaja con la entrada ARP del router: cuando conserva la que aprendió mientras el equipo
estaba encendido, el reenvío tiene destino y funciona; cuando la ha desalojado, tiene que
preguntar por ARP, la tarjeta en modo espera no contesta, y el paquete se pierde. Cuándo la
desaloja no es predecible desde fuera.

En el router hace falta **una** de estas cosas, en orden de preferencia:

- **Enlace fijo IP↔MAC** (*static ARP*, *IP-MAC binding*, *ARP estático*): se ata la IP del
  equipo a la MAC de su tarjeta, y así el reenvío tiene destino aunque esté apagado. Es la
  opción limpia, pero no todos los routers domésticos la traen.
- **Reserva DHCP** para esa MAC. Ojo: solo sirve si el equipo coge la IP **por DHCP**. Aquí
  la tiene configurada a mano (`proto static`), así que el router nunca se la asignó y no
  guarda ninguna asociación. Pasar el equipo a DHCP con reserva hace que el router mantenga
  él la relación IP↔MAC, que es justo lo que falta.
- **Reenviar UDP/9 a la dirección de difusión** de la red (`…​.255`) en vez de a la IP del
  equipo. Lo más simple de entender, pero muchos routers rechazan una difusión como destino.

Lo que **no** funciona desde fuera: mandar el paquete a `255.255.255.255`. Esa difusión es
local y ningún router de internet la reenvía; solo sirve estando ya dentro de la red (que es
lo que hace `tools/despertar.sh`).

Y en el equipo, que la tarjeta quede armada en cada arranque (`ethtool <iface> wol g`). Aquí
ya lo hace un `wol-enable.service` propio; si montas esto en otra máquina, tendrás que
añadirlo.

### Dos consecuencias que conviene tener claras antes de activarlo:

- Los servidores **dejan de arrancar solos al encender**. Los levanta el agente cuando hay
  una reserva. Si arrancaran solos siempre habría algo corriendo y la máquina no se apagaría
  nunca.
- La máquina **se apaga sola** en cuanto no queda nadie jugando, ninguna reserva en marcha,
  nadie en la cola ni ninguna sesión SSH abierta. Para volver a encenderla, una reserva desde
  la web (o Wake-on-LAN a mano).

## Estructura

```
ansible/
├── playbook.yml
├── inventory.ini
├── ansible.cfg
├── group_vars/
│   ├── all.yml.sample      # plantilla versionada
│   └── all.yml             # configuración real (ignorada por git)
├── roles/l4d2_fleet/
│   ├── tasks/              # dependencias, juego, zonemod, flota, monitoreo
│   ├── templates/          # unit de systemd, fleet.env, promtail, loki
│   ├── files/              # launcher, exporter, plugins propios, MOTD
│   └── defaults/main.yml   # valores por defecto (versionado)
└── roles/summon_agent/     # opcional: conecta la flota con la plataforma
    ├── files/              # el agente y el plugin de admin por servidor
    ├── templates/          # unit de systemd y su archivo de entorno
    └── defaults/main.yml
```

> Los plugins propios se **compilan en el host** desde su `.sp`, con el compilador que trae
> SourceMod. No se versionan los `.smx`: un binario en el repo se queda viejo en cuanto
> alguien toca la fuente, y nada avisa de que dejaron de coincidir.

Documentación de detalle en [`docs/`](docs/).
