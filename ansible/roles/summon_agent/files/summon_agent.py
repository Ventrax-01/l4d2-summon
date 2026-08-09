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

Todo lo que este agente hace mal es caro de arreglar: si se apaga cuando no debía, alguien
se queda sin partida; si no se apaga, la factura de la luz corre; y si se apaga mal, la
máquina puede quedar fuera de alcance. Por eso casi cada decisión se vuelve a comprobar
aquí, con los hechos delante, en vez de fiarse de lo que la nube decidió hace un rato.
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
# ponen en /etc/hosts para el nombre de la máquina. Apuntar al primero da "connection
# refused" a secas; es el fallo que más tiempo cuesta encontrar.
RCON_HOST = os.environ.get("RCON_HOST", "127.0.1.1")

# Si la nube lleva tanto tiempo incomunicada, la máquina se apaga por su cuenta. Sin esto,
# un fallo de red o de DNS la dejaría encendida indefinidamente sin que nadie —ni la web ni
# el barrido— pudiera hacer nada, porque desde fuera parecería apagada.
INCOMUNICADO_MAX_S = int(os.environ.get("OFFLINE_SHUTDOWN_SEC", "900"))

# El estado que debe sobrevivir a un reinicio del agente. Sin él, reiniciar el servicio
# reejecutaría órdenes ya hechas y olvidaría a quién le tocaba ser admin.
ESTADO = os.environ.get("STATE_FILE", "/var/lib/summon-agent/estado.json")

A2S_INFO = b"\xFF\xFF\xFF\xFF\x54Source Engine Query\x00"
# La de los nombres. Lleva el reto pegado detrás, por eso va sin terminador.
A2S_PLAYER = b"\xFF\xFF\xFF\xFF\x55"


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

# ---------------------------------------------------------------- estado en disco

estado = {
    "hechas": {},           # id de orden -> cuándo se ejecutó
    "pendiente_admin": {},  # slot -> steamid al que hay que dar el mando cuando cargue
    "sembrado": {},         # slot -> steamid que ya lo tiene
    "bans_reenganchado": {},  # slot -> ya se recuperó la conexión de baneos tras arrancar
}


def cargar_estado():
    global estado
    try:
        with open(ESTADO) as f:
            guardado = json.load(f)
        for k in estado:
            if isinstance(guardado.get(k), dict):
                estado[k] = guardado[k]
        # Las órdenes viejas se olvidan: solo interesan para no repetir lo reciente.
        limite = time.time() - 7200
        estado["hechas"] = {k: v for k, v in estado["hechas"].items() if v > limite}
    except FileNotFoundError:
        pass
    except Exception as e:
        log("no se pudo leer el estado guardado; se empieza de cero", error=str(e))


def guardar_estado():
    try:
        os.makedirs(os.path.dirname(ESTADO), exist_ok=True)
        tmp = ESTADO + ".tmp"
        with open(tmp, "w") as f:
            json.dump(estado, f)
        os.replace(tmp, ESTADO)  # atómico: nunca se lee un archivo a medio escribir
    except Exception as e:
        log("no se pudo guardar el estado", error=str(e))


# ---------------------------------------------------------------- mirar

def consultar_a2s(puerto: int, intentos: int = 3) -> dict:
    """Jugadores y mapa de un servidor.

    Devuelve {} SOLO si no contestó, y eso NO es lo mismo que estar vacío: un datagrama
    perdido o los segundos de una transición de campaña dejarían un servidor lleno como
    desierto, y sobre "desierto" se decide cerrar servidores y apagar la máquina. Por eso
    se reintenta antes de darlo por mudo, y quien lea esto debe distinguir {} de players=0.
    """
    for intento in range(intentos):
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
                # `total` incluye a los bots; se restan para contar personas de verdad, que
                # es lo que decide si un servidor está vacío.
                total, maximo, bots = resto[2], resto[3], resto[4]
                return {
                    "respondio": True,
                    "map": mapa,
                    "players": max(0, total - bots),
                    "bots": bots,
                    "maxPlayers": maximo,
                }
        except Exception:
            pass
        finally:
            s.close()
        if intento + 1 < intentos:
            time.sleep(0.3)
    return {}


def consultar_nombres(puerto: int) -> list:
    """Los nombres de quienes están dentro.

    Es una consulta distinta de la de arriba —A2S_PLAYER— y va en dos pasos: el servidor
    contesta primero con un reto que hay que devolverle. Sin eso no responde.

    A diferencia del recuento, esto es decorativo: alimenta el globo de la web y nada más.
    Por eso un solo intento y sin reintentos: si se pierde, la vuelta siguiente lo arregla y
    mientras tanto no se decide nada con ello.

    La lista va tal como la devuelve el servidor, sin filtrar. En L4D2 los supervivientes
    controlados por la máquina no salen aquí, pero si algún día saliera alguno tampoco
    importaría: el recuento de personas se sigue sacando de la otra consulta, que sí marca
    los bots aparte.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    try:
        s.sendto(A2S_PLAYER + b"\xFF\xFF\xFF\xFF", (GAME_IP, puerto))
        datos, _ = s.recvfrom(4096)
        if datos[4:5] == b"\x41":  # el reto
            s.sendto(A2S_PLAYER + datos[5:9], (GAME_IP, puerto))
            datos, _ = s.recvfrom(4096)
        if datos[4:5] != b"\x44":
            return []
        nombres = []
        resto = datos[6:]
        while resto:
            # índice (1) + nombre terminado en cero + puntuación (4) + tiempo jugado (4)
            resto = resto[1:]
            fin = resto.find(b"\x00")
            if fin < 0:
                break
            nombre = resto[:fin].decode("utf-8", "replace").strip()
            resto = resto[fin + 1 + 8:]
            if nombre:
                nombres.append(nombre)
        return nombres[:32]
    except Exception:
        return []
    finally:
        s.close()


def interfaz_principal() -> str:
    """La tarjeta por la que sale el tráfico, que es la que tiene que despertar."""
    try:
        r = subprocess.run(["/usr/sbin/ip", "route", "get", "8.8.8.8"],
                           capture_output=True, text=True, timeout=5)
        partes = r.stdout.split()
        return partes[partes.index("dev") + 1]
    except Exception:
        return ""


def armar_wol() -> str:
    """Deja la tarjeta escuchando el paquete mágico y devuelve el modo resultante.

    Se llama en dos momentos, y el que importa es el segundo: al arrancar el agente, por si
    el servicio de arranque perdió su carrera con la red, y **justo antes de apagar**, que
    es el último instante en que alguien puede comprobarlo. Una máquina que se apaga con la
    tarjeta sin armar no vuelve hasta que alguien va a pulsar el botón.

    Devuelve el modo tal como lo reporta la tarjeta: 'g' es lo que se quiere (magic packet),
    'd' significa desactivado.
    """
    iface = interfaz_principal()
    if not iface:
        return "?"
    try:
        subprocess.run(["/usr/sbin/ethtool", "-s", iface, "wol", "g"], timeout=10,
                       capture_output=True)
        r = subprocess.run(["/usr/sbin/ethtool", iface], capture_output=True, text=True, timeout=10)
        for linea in r.stdout.splitlines():
            if "Wake-on:" in linea and "Supports" not in linea:
                return linea.split(":", 1)[1].strip()
    except Exception as e:
        log("no se pudo armar el wake-on-lan", iface=iface, error=str(e))
    return "?"


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
      State=closing  — una sesión que ya se está yendo. Medido en esta flota, puede quedarse
                       así más de dos minutos; contarla bloquearía el apagado.

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
                props = dict(l.split("=", 1) for l in p.stdout.splitlines() if "=" in l)
                if props.get("Class") == "user" and props.get("State") != "closing":
                    return True
            return False
    except Exception:
        pass

    # Respaldo por si logind no contesta. El patrón cubre las dos formas de nombrar los
    # procesos de sesión: OpenSSH < 9.8 usa "sshd: usuario@pts/0" y desde 9.8 el binario se
    # partió y son "sshd-session: usuario@pts/0". Este servidor corre OpenSSH 10, así que
    # con el patrón antiguo el respaldo no habría visto ninguna sesión.
    try:
        r = subprocess.run(
            ["/usr/bin/pgrep", "-f", r"sshd(-session)?: .*@"], capture_output=True, timeout=5
        )
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
    return "OK" in rcon(puerto, "sm_summon_admin %s" % steam_id)


def reenganchar_bans(puerto: int) -> bool:
    """Recupera la conexión del plugin de baneos, que se pierde en cada arranque.

    Un L4D2 sin nadie dentro hiberna: deja de correr frames, y sin frames no se despachan
    las respuestas asíncronas. El plugin pide su conexión a la base nada más cargar —o sea,
    en plena hibernación— y esa respuesta se pierde por el camino. Como él se queda marcado
    como "conectando", tampoco reintenta nunca: se queda mudo para siempre y los baneos se
    caen por dentro sin escribir nada.

    Recargarlo con el servidor ya despierto rehace la conexión. Se hace una sola vez por
    arranque, cuando entra el primer jugador, que es justo cuando el servidor deja de
    hibernar. Es transparente para quien está jugando.
    """
    return "sourcebans" in rcon(puerto, "sm plugins reload sbpp_main").lower()


# ---------------------------------------------------------------- órdenes

def levantar(n: int, admin_steam_id: str) -> bool:
    subprocess.run(["/usr/bin/systemctl", "restart", "l4d2@%d.service" % n], timeout=60)
    # Proceso nuevo, plugin nuevo: la conexión de baneos vuelve a hacer falta.
    estado["bans_reenganchado"].pop(str(n), None)
    guardar_estado()
    if admin_steam_id:
        # El servidor tarda en cargar; el admin se siembra en la vuelta siguiente, cuando ya
        # responda el RCON. Aquí solo queda anotado —y en disco, para que un reinicio del
        # agente no entregue el servidor sin admin.
        estado["pendiente_admin"][str(n)] = admin_steam_id
        estado["sembrado"].pop(str(n), None)
        guardar_estado()
    log("servidor levantado", slot=n, puerto=PORT_BASE + n)
    return True


AVISO_CIERRE_S = int(os.environ.get("CLOSE_WARNING_SEC", "10"))


def parar(n: int, forzado: bool = False) -> bool:
    """Para un servidor.

    Hay dos maneras de llegar aquí y NO se tratan igual:

      · Cierre por inactividad (forzado=False). La orden se decidió hace rato con datos que
        pueden haber caducado; si entretanto entró alguien, pararlo sería echarlo de su
        partida. Se deja sin confirmar para que la nube lo reevalúe.

      · Cierre pedido por el dueño (forzado=True). Aquí no hay nada que reevaluar: alguien
        pulsó "cerrar" hace segundos sabiendo lo que hacía. Antes esto caía en la guarda de
        arriba y el servidor seguía vivo con la gente dentro pese a que la web decía que se
        había cerrado. Ahora se avisa por el chat, se da un margen para despedirse y se
        desaloja.
    """
    puerto = PORT_BASE + n

    if unidad_activa(n):
        info = consultar_a2s(puerto)
        jugadores = info.get("players", 0)

        if jugadores > 0 and not forzado:
            log("parada cancelada: hay gente dentro", slot=n, jugadores=jugadores)
            return False

        if jugadores > 0 and forzado:
            # Cortar de golpe deja a la gente con un "conexión perdida" sin explicación.
            rcon(puerto, 'sm_say [Summon] El dueno cerro el servidor. Se apaga en %d segundos.'
                 % AVISO_CIERRE_S)
            log("cierre forzado avisado", slot=n, jugadores=jugadores, enSegundos=AVISO_CIERRE_S)
            time.sleep(AVISO_CIERRE_S)
            rcon(puerto, 'sm_kick @all "El dueno cerro este servidor"')
            time.sleep(1)

    subprocess.run(["/usr/bin/systemctl", "stop", "l4d2@%d.service" % n], timeout=60)
    estado["pendiente_admin"].pop(str(n), None)
    estado["sembrado"].pop(str(n), None)
    estado["bans_reenganchado"].pop(str(n), None)
    guardar_estado()
    log("servidor parado", slot=n)
    return True


def nada_sostiene_la_maquina() -> bool:
    """Comprueba, con los hechos delante, que de verdad no queda nadie."""
    if hay_sesion_ssh():
        log("apagado cancelado: hay una sesión abierta")
        return False

    for n in range(1, SERVER_COUNT + 1):
        if not unidad_activa(n):
            continue
        info = consultar_a2s(PORT_BASE + n)
        if not info:
            # Corriendo pero mudo tras varios intentos: pudo quedarse colgado. No se
            # bloquea el apagado por esto —si no, un servidor zombi dejaría la máquina
            # encendida para siempre—, pero queda dicho en el registro.
            log("servidor activo que no responde; se cuenta como vacío", slot=n)
            continue
        if info.get("players", 0) > 0:
            log("apagado cancelado: hay gente jugando", slot=n, jugadores=info["players"])
            return False
    return True


def apagar(orden_id: str) -> bool:
    """Apaga la máquina. Es el final del ciclo: nadie juega, nadie espera.

    Lo delicado no es apagar, es AVISAR ANTES. Si la máquina se fuera sin decir nada:

      · La orden quedaría sin confirmar en la cola de la nube, y al siguiente arranque —el
        manual, el que uno hace para averiguar por qué no despertó— el agente se la
        encontraría y volvería a apagar la máquina a los segundos. En bucle, y sin forma de
        ganarle la carrera desde fuera.
      · La nube seguiría viendo el host como encendido durante minuto y medio (hasta que
        caduque el latido), y una reserva hecha en esa ventana NO mandaría el paquete de
        encendido, porque creería que la máquina ya está despierta. La reserva moriría por
        plazo sin haber intentado nada.

    Así que primero se avisa —de forma síncrona, esperando la respuesta— y solo después se
    apaga. Si el aviso falla, no se apaga: se deja para la vuelta siguiente.
    """
    if not nada_sostiene_la_maquina():
        return False

    # Antes de nada, asegurar el camino de vuelta. Apagarse con la tarjeta sin armar deja la
    # máquina fuera de alcance hasta que alguien vaya a pulsar el botón.
    modo = armar_wol()
    if modo != "g":
        log("AVISO: la tarjeta no quedó armada; se apaga igual pero puede no despertar",
            modo=modo)

    try:
        hablar_con_la_nube({
            "sshActive": False,
            "slots": [],
            "confirmadas": [orden_id],
            "apagando": True,
            "wolArmado": modo,
        })
    except Exception as e:
        log("no se pudo avisar del apagado; se pospone", error=str(e))
        return False

    log("apagando la máquina", wolArmado=modo)
    subprocess.Popen(["/usr/bin/systemctl", "poweroff"])
    return True


def ejecutar(orden: dict) -> bool:
    tipo = orden.get("tipo")
    slot = orden.get("slotIndex")
    ident = orden.get("id", "")

    # Una orden ya ejecutada no se repite. La confirmación viaja en el POST siguiente, así
    # que siempre hay una vuelta en la que la nube nos la vuelve a entregar; sin esta
    # comprobación, un LEVANTAR reentregado reiniciaría un servidor con gente dentro.
    if ident and ident in estado["hechas"]:
        return True

    try:
        if tipo == "LEVANTAR" and slot:
            hecho = levantar(int(slot), orden.get("adminSteamId", ""))
        elif tipo == "PARAR" and slot:
            hecho = parar(int(slot), bool(orden.get("forzado")))
        elif tipo == "APAGAR":
            # No pasa por el registro de ejecutadas: si el apagado se cancela hay que poder
            # reintentarlo, y si se lleva a cabo esta máquina ya no está para recordarlo.
            return apagar(ident)
        else:
            log("orden desconocida", tipo=tipo)
            return True  # se confirma igual: repetirla no la haría válida

        if hecho and ident:
            estado["hechas"][ident] = time.time()
            guardar_estado()
        return hecho
    except Exception as e:
        log("la orden falló", tipo=tipo, slot=slot, error=str(e))
        return False


# ---------------------------------------------------------------- vuelta

def reportar_slots() -> list:
    reportes = []
    for n in range(1, SERVER_COUNT + 1):
        corriendo = unidad_activa(n)
        r = {"index": n, "corriendo": corriendo}

        if corriendo:
            puerto = PORT_BASE + n
            r.update(consultar_a2s(puerto))
            # Solo si hay alguien: en un servidor vacío es una consulta a cambio de nada.
            if r.get("players", 0) > 0:
                r["nombres"] = consultar_nombres(puerto)
            # Solo se pregunta por los plugins si el servidor ya responde al juego: si no,
            # es RCON al vacío en cada vuelta.
            if r.get("map"):
                r["pluginsOk"] = plugins_cargados(puerto)

            # El admin se siembra en cuanto el servidor puede recibirlo.
            esperando = estado["pendiente_admin"].get(str(n))
            if esperando and r.get("pluginsOk"):
                if sembrar_admin(puerto, esperando):
                    estado["sembrado"][str(n)] = esperando
                    estado["pendiente_admin"].pop(str(n), None)
                    guardar_estado()
                    log("admin sembrado", slot=n, steamId=esperando)
            # Solo se declara sembrado si de verdad se sembró, o si nunca hubo nada que
            # sembrar. Antes bastaba con no tener nada pendiente, y como lo pendiente vivía
            # en memoria, un reinicio del agente entregaba el servidor sin admin diciendo
            # que sí lo tenía.
            r["adminSembrado"] = bool(estado["sembrado"].get(str(n))) or not esperando

            # Con el primer jugador el servidor sale de la hibernación, y es el momento —el
            # único— en que el plugin de baneos puede recuperar su conexión. Ver
            # reenganchar_bans() para por qué no lo hace solo.
            if r.get("players", 0) > 0 and not estado["bans_reenganchado"].get(str(n)):
                if reenganchar_bans(puerto):
                    estado["bans_reenganchado"][str(n)] = True
                    guardar_estado()
                    log("baneos reenganchados", slot=n)

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


def ordenar(ordenes: list) -> list:
    """LEVANTAR y PARAR antes que APAGAR.

    Si llegan juntas —la nube decidió apagar y, antes de que recogiéramos la orden, entró
    una reserva—, apagar primero dejaría la máquina muerta con una reserva recién concedida.
    Ejecutando en este orden, el LEVANTAR se hace y el APAGAR se encuentra la máquina
    ocupada y se cancela solo.
    """
    peso = {"LEVANTAR": 0, "PARAR": 1, "APAGAR": 2}
    return sorted(ordenes, key=lambda o: peso.get(o.get("tipo"), 1))


def vuelta(confirmadas: list, wol_armado: str) -> list:
    respuesta = hablar_con_la_nube(
        {
            "sshActive": hay_sesion_ssh(),
            "slots": reportar_slots(),
            "confirmadas": confirmadas,
            # Viaja en cada latido para poder verlo desde la nube sin entrar a la maquina.
            # Es el dato que dice si el camino de vuelta existe.
            "wolArmado": wol_armado,
        }
    )

    hechas = []
    levanto_algo = False
    for orden in ordenar(respuesta.get("ordenes", [])):
        # Si en este mismo lote se acaba de levantar un servidor, el apagado que venía
        # detrás se descarta sin más: se decidió antes de que existiera esa reserva.
        if orden.get("tipo") == "APAGAR" and levanto_algo:
            log("apagado descartado: en este lote venía un LEVANTAR")
            continue
        if ejecutar(orden):
            hechas.append(orden["id"])
            if orden.get("tipo") == "LEVANTAR":
                levanto_algo = True
    return hechas


def main():
    if not URL or not TOKEN:
        log("falta SUMMON_URL o SUMMON_TOKEN; revisa /etc/l4d2-fleet/summon-agent.env")
        sys.exit(1)

    cargar_estado()

    # Se arma al arrancar ademas de antes de apagar: si el servicio de arranque perdio su
    # carrera con la red, aqui se corrige, y de paso queda anotado como llego la tarjeta.
    modo_previo = armar_wol()
    log("agente en marcha", url=URL, servidores=SERVER_COUNT, periodo=PERIODO_S,
        wolArmado=modo_previo)

    confirmadas: list = []
    fallos = 0
    ultimo_contacto = time.time()

    while True:
        try:
            confirmadas = vuelta(confirmadas, modo_previo)
            ultimo_contacto = time.time()
            fallos = 0
        except urllib.error.HTTPError as e:
            # 401 es de configuración, no de red: insistir no lo arregla, pero tampoco se
            # sale del bucle — el token se puede corregir sin reiniciar el servicio.
            log("la nube rechazó el latido", codigo=e.code)
            fallos += 1
        except Exception as e:
            log("no se pudo hablar con la nube", error=str(e))
            fallos += 1

        incomunicado = time.time() - ultimo_contacto
        if incomunicado > INCOMUNICADO_MAX_S and nada_sostiene_la_maquina():
            # Sin línea con la nube nadie puede apagar esta máquina desde fuera: la web la
            # ve caída y el barrido no tiene a quién mandarle la orden. Se apaga sola para
            # no quedarse encendida indefinidamente por un fallo de red.
            log("apagado por incomunicación", segundos=int(incomunicado))
            subprocess.Popen(["/usr/bin/systemctl", "poweroff"])
            return

        # Con la red caída se espacian los intentos hasta un minuto: la máquina puede estar
        # arrancando y el DNS aún no responder.
        espera = min(PERIODO_S * (2 ** min(fallos, 2)), 60) if fallos else PERIODO_S
        time.sleep(espera)


if __name__ == "__main__":
    main()
