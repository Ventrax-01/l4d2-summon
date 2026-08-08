#!/usr/bin/env python3
"""Agente de l4d2-summon: el lado de la casa.

La nube no puede entrar aquí — no hay puertos abiertos ni IP fija — así que la conversación
va siempre en un sentido: este proceso pregunta cada pocos segundos, cuenta lo que ve y se
lleva las órdenes que haya. Nada entra sin que lo hayamos pedido nosotros.

En cada vuelta hace tres cosas:

    1. Mira los servidores    — A2S para jugadores y mapa, systemd para saber si corren.
    2. Lo cuenta              — un POST con el estado de la flota.
    3. Ejecuta lo que traiga  — levantar, parar o apagar la máquina.

Sin dependencias externas a propósito: solo la biblioteca estándar. Este proceso tiene que
arrancar antes que nada y sobrevivir a que el resto del sistema esté a medio instalar.
"""
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- configuración

URL = os.environ.get("SUMMON_URL", "").rstrip("/")
TOKEN = os.environ.get("SUMMON_TOKEN", "")
PORT_BASE = int(os.environ.get("PORT_BASE", "6032"))
SERVER_COUNT = int(os.environ.get("SERVER_COUNT", "4"))
RCON_PASSWORD = os.environ.get("RCON_PASSWORD", "")
PERIODO_S = int(os.environ.get("POLL_SEC", "15"))

# srcds NO escucha el RCON en 127.0.0.1 sino en 127.0.1.1, que es lo que Debian y Ubuntu
# ponen en /etc/hosts para el nombre de la máquina. Conectarse al primero da "connection
# refused" sin más explicación; es el fallo que más tiempo cuesta encontrar.
RCON_HOST = os.environ.get("RCON_HOST", "127.0.1.1")

A2S_INFO = b"\xFF\xFF\xFF\xFF\x54Source Engine Query\x00"


def log(msg, **datos):
    """Una línea por evento, a journald. Sin ruido: esto corre cada 15 segundos."""
    if datos:
        msg = "%s %s" % (msg, json.dumps(datos, ensure_ascii=False))
    print(msg, flush=True)


def ip_principal() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


GAME_IP = os.environ.get("GAME_IP") or ip_principal()

# ---------------------------------------------------------------- mirar

def consultar_a2s(puerto: int) -> dict:
    """Jugadores y mapa de un servidor. Devuelve {} si no contesta."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    try:
        s.sendto(A2S_INFO, (GAME_IP, puerto))
        datos, _ = s.recvfrom(4096)
        if datos[4:5] == b"\x41":  # el servidor pide repetir con su token
            s.sendto(A2S_INFO + datos[5:9], (GAME_IP, puerto))
            datos, _ = s.recvfrom(4096)
        if datos[4:5] == b"\x49":
            resto = datos[6:]

            def leer(buf):
                i = buf.index(0)
                return buf[:i].decode("utf-8", "replace"), buf[i + 1:]

            _nombre, resto = leer(resto)
            mapa, resto = leer(resto)
            _carpeta, resto = leer(resto)
            _juego, resto = leer(resto)
            # players incluye a los bots; se restan para contar personas de verdad, que es
            # lo que decide si el servidor está vacío y hay que cerrarlo.
            total, maximo, bots = resto[2], resto[3], resto[4]
            return {"map": mapa, "players": max(0, total - bots), "bots": bots, "maxPlayers": maximo}
    except Exception:
        pass
    finally:
        s.close()
    return {}


def unidad_activa(n: int) -> bool:
    try:
        r = subprocess.run(
            ["/usr/bin/systemctl", "is-active", "--quiet", "l4d2@%d.service" % n], timeout=5
        )
        return r.returncode == 0
    except Exception:
        return False


def hay_sesion_ssh() -> bool:
    """¿Hay una persona conectada? Si la hay, la máquina no se apaga: cortarle la sesión a
    media faena es peor que tenerla encendida unos minutos de más.

    NO se usa `who`: lee /var/run/utmp y hay instalaciones donde nadie lo escribe — en esta
    misma flota `who` sale vacío con sesiones SSH abiertas. Se pregunta a logind.

    Pero NO vale contar las sesiones que lista logind, porque no todas son personas:

      Class=manager  — el gestor de systemd del usuario (user@1000.service). Aparece solo,
                       sobrevive a la desconexión y no corresponde a nadie conectado.
                       Contarla equivale a decir "siempre hay alguien": la máquina no se
                       apagaría jamás.
      State=closing  — una sesión que ya se está yendo. Si se quedara atascada en ese
                       estado bloquearía el apagado para siempre.

    Así que solo cuentan las de Class=user que sigan activas. Se consulta sesión por sesión
    en vez de leer las columnas de `list-sessions` porque ese formato cambia entre versiones
    de systemd, y aquí equivocarse sale caro en las dos direcciones.
    """
    try:
        r = subprocess.run(
            ["/usr/bin/loginctl", "list-sessions", "--no-legend"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            for linea in r.stdout.splitlines():
                if not linea.strip():
                    continue
                sid = linea.split()[0]
                p = subprocess.run(
                    ["/usr/bin/loginctl", "show-session", sid, "-p", "Class", "-p", "State"],
                    capture_output=True, text=True, timeout=5,
                )
                props = dict(
                    l.split("=", 1) for l in p.stdout.splitlines() if "=" in l
                )
                if props.get("Class") == "user" and props.get("State") != "closing":
                    return True
            return False
    except Exception:
        pass

    try:
        r = subprocess.run(["/usr/bin/pgrep", "-f", r"sshd: .*@"], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        # Ante la duda se declara ocupada: quedarse encendida de más cuesta unos céntimos,
        # apagar a alguien en mitad de una sesión cuesta su trabajo.
        return True


# ---------------------------------------------------------------- RCON

ID_COMANDO = 2
ID_CENTINELA = 3


def rcon(puerto: int, comando: str) -> str:
    """Manda un comando por RCON y devuelve su salida. Cadena vacía si algo falla.

    Dos detalles del protocolo de Source que hay que respetar o las respuestas salen
    corridas un paquete —y entonces todo parece funcionar mientras devuelve lo que no es:

    1. A la autenticación contesta con DOS paquetes: primero uno vacío de tipo 0 y después
       el de tipo 2, que es el que dice si la contraseña valía. Hay que leer hasta el tipo 2
       y tirar lo anterior.

    2. Una respuesta larga viene partida en varios paquetes, y nada marca cuál es el último.
       El truco conocido es mandar detrás un comando vacío con otro identificador: cuando
       llega la respuesta a ESE, la anterior ya terminó de llegar entera.
    """
    if not RCON_PASSWORD:
        return ""

    def paquete(ident: int, tipo: int, cuerpo: str) -> bytes:
        datos = struct.pack("<ii", ident, tipo) + cuerpo.encode("utf-8") + b"\x00\x00"
        return struct.pack("<i", len(datos)) + datos

    def recibir(s, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            trozo = s.recv(n - len(buf))
            if not trozo:
                raise ConnectionError("el servidor cerró la conexión")
            buf += trozo
        return buf

    def leer(s) -> tuple:
        largo = struct.unpack("<i", recibir(s, 4))[0]
        datos = recibir(s, largo)
        ident, tipo = struct.unpack("<ii", datos[:8])
        return ident, tipo, datos[8:-2].decode("utf-8", "replace")

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect((RCON_HOST, puerto))

        s.sendall(paquete(1, 3, RCON_PASSWORD))  # 3 = autenticar
        while True:
            ident, tipo, _ = leer(s)
            if tipo != 2:
                continue  # el paquete vacío de cortesía
            if ident == -1:
                log("rcon: contraseña rechazada", puerto=puerto)
                return ""
            break

        s.sendall(paquete(ID_COMANDO, 2, comando))
        s.sendall(paquete(ID_CENTINELA, 2, ""))

        partes = []
        while True:
            ident, _tipo, cuerpo = leer(s)
            if ident == ID_CENTINELA:
                break
            if ident == ID_COMANDO:
                partes.append(cuerpo)
        return "".join(partes)
    except Exception as e:
        log("rcon: sin respuesta", puerto=puerto, error=str(e))
        return ""
    finally:
        s.close()


def plugins_cargados(puerto: int) -> bool:
    """SourceMod responde a esto solo cuando terminó de cargar. Es la señal de que el
    servidor está listo de verdad, no solo de que el proceso arrancó."""
    return "SourceMod" in rcon(puerto, "sm version")


def sembrar_admin(puerto: int, steam_id: str) -> bool:
    """Da el mando de ESE servidor a quien lo reservó.

    No se toca admins_simple.ini: ese fichero es del install compartido, así que un admin
    escrito ahí lo sería en los cuatro servidores a la vez. El plugin summon_admin mantiene
    el permiso en memoria y solo para esta instancia.
    """
    salida = rcon(puerto, "sm_summon_admin %s" % steam_id)
    return "OK" in salida


# ---------------------------------------------------------------- órdenes

def levantar(n: int, admin_steam_id: str) -> bool:
    puerto = PORT_BASE + n
    subprocess.run(["/usr/bin/systemctl", "restart", "l4d2@%d.service" % n], timeout=60)
    if admin_steam_id:
        # El servidor tarda en cargar; el admin se siembra en la vuelta siguiente cuando ya
        # responda el RCON. Aquí solo se deja anotado.
        PENDIENTE_ADMIN[n] = admin_steam_id
    log("servidor levantado", slot=n, puerto=puerto)
    return True


def parar(n: int) -> bool:
    subprocess.run(["/usr/bin/systemctl", "stop", "l4d2@%d.service" % n], timeout=60)
    PENDIENTE_ADMIN.pop(n, None)
    SEMBRADO.pop(n, None)
    log("servidor parado", slot=n)
    return True


def apagar() -> bool:
    """Apaga la máquina. Es el final del ciclo: nadie juega, nadie espera.

    Las condiciones se vuelven a comprobar AQUÍ, aunque la nube ya las mirara, porque una
    orden puede pasar hasta una hora en la cola antes de que alguien la recoja. En ese hueco
    perfectamente pudo entrar el operador por SSH o llenarse un servidor de gente; apagar
    entonces sería obedecer una decisión que ya no vale. El agente es quien tiene los hechos
    delante, así que es quien manda sobre la orden.

    Devolver False la deja sin confirmar: la nube la sigue teniendo pendiente, pero la
    volverá a evaluar y la retirará cuando toque.
    """
    if hay_sesion_ssh():
        log("apagado cancelado: hay una sesión abierta")
        return False

    for n in range(1, SERVER_COUNT + 1):
        if not unidad_activa(n):
            continue
        info = consultar_a2s(PORT_BASE + n)
        if info.get("players", 0) > 0:
            log("apagado cancelado: hay gente jugando", slot=n, jugadores=info["players"])
            return False

    log("apagando la máquina")
    subprocess.Popen(["/usr/bin/systemctl", "poweroff"])
    return True


PENDIENTE_ADMIN: dict = {}   # slot -> steamid al que hay que dar el mando cuando cargue
SEMBRADO: dict = {}          # slot -> steamid que ya tiene el mando


def ejecutar(orden: dict) -> bool:
    tipo = orden.get("tipo")
    slot = orden.get("slotIndex")
    try:
        if tipo == "LEVANTAR" and slot:
            return levantar(int(slot), orden.get("adminSteamId", ""))
        if tipo == "PARAR" and slot:
            return parar(int(slot))
        if tipo == "APAGAR":
            return apagar()
        log("orden desconocida", tipo=tipo)
        return True  # se confirma igual: reintentarla eternamente no la haría válida
    except Exception as e:
        log("la orden falló", tipo=tipo, slot=slot, error=str(e))
        return False


# ---------------------------------------------------------------- vuelta

def reportar_slots() -> list:
    reportes = []
    for n in range(1, SERVER_COUNT + 1):
        puerto = PORT_BASE + n
        corriendo = unidad_activa(n)
        r = {"index": n, "corriendo": corriendo}

        if corriendo:
            r.update(consultar_a2s(puerto))
            # Solo se pregunta por los plugins si el servidor ya responde al juego: si no,
            # es RCON al vacío en cada vuelta.
            if r.get("map"):
                r["pluginsOk"] = plugins_cargados(puerto)

            # El admin se siembra en cuanto el servidor puede recibirlo.
            esperando = PENDIENTE_ADMIN.get(n)
            if esperando and r.get("pluginsOk"):
                if sembrar_admin(puerto, esperando):
                    SEMBRADO[n] = esperando
                    PENDIENTE_ADMIN.pop(n, None)
                    log("admin sembrado", slot=n, steamId=esperando)
            r["adminSembrado"] = bool(SEMBRADO.get(n)) or not esperando

        reportes.append(r)
    return reportes


def hablar_con_la_nube(cuerpo: dict) -> dict:
    peticion = urllib.request.Request(
        "%s/agent/poll" % URL,
        data=json.dumps(cuerpo).encode("utf-8"),
        headers={"authorization": "Bearer %s" % TOKEN, "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(peticion, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def vuelta(confirmadas: list) -> list:
    respuesta = hablar_con_la_nube(
        {
            "publicIp": None,
            "sshActive": hay_sesion_ssh(),
            "slots": reportar_slots(),
            "confirmadas": confirmadas,
        }
    )

    hechas = []
    for orden in respuesta.get("ordenes", []):
        if ejecutar(orden):
            hechas.append(orden["id"])
    return hechas


def main():
    if not URL or not TOKEN:
        log("falta SUMMON_URL o SUMMON_TOKEN; revisa /etc/summon-agent.env")
        sys.exit(1)

    log("agente en marcha", url=URL, servidores=SERVER_COUNT, periodo=PERIODO_S)
    confirmadas: list = []
    fallos = 0

    while True:
        try:
            confirmadas = vuelta(confirmadas)
            fallos = 0
        except urllib.error.HTTPError as e:
            # 401 es de configuración, no de red: insistir no lo arregla, pero tampoco se
            # sale del bucle — el token se puede corregir sin reiniciar el servicio.
            log("la nube rechazó el latido", codigo=e.code)
            fallos += 1
        except Exception as e:
            log("no se pudo hablar con la nube", error=str(e))
            fallos += 1

        # Con la red caída se espacian los intentos hasta un minuto: la máquina puede estar
        # arrancando y el DNS aún no responder.
        espera = min(PERIODO_S * (2 ** min(fallos, 2)), 60) if fallos else PERIODO_S
        time.sleep(espera)


if __name__ == "__main__":
    main()
