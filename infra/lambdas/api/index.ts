/* API pública: lo que consume el navegador.

   El endpoint que de verdad importa es GET /api/state: devuelve la flota entera más lo que
   le pasa a quien pregunta. La interfaz se apaña con ese solo, lo que mantiene el número de
   invocaciones bajo — que es lo que decide el coste de este sistema.

   El stepper se calcula AQUÍ y se manda ya resuelto ({total, actual, etiquetas}). Así la
   interfaz no necesita conocer los estados internos de la máquina, y las dos duraciones no
   generan ramas en el navegador. */

import { error, ok } from '../shared/http'
import { vieneDeCloudFront } from '../shared/origen'
import { secreto } from '../shared/ssm'
import { verificar, sesionDeCookies, type Sesion } from '../shared/jwt'
import { obtener } from '../shared/usuarios'
import * as m from '../shared/modelo'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { puertaSourcebans } from './sourcebans'

const SSM_JWT = process.env.ssmJwt!
const HOST_JUEGO = process.env.gameHost!
const FN_WOL = process.env.wolFunction
/** Dónde vive el panel de baneos. Es otro dominio a propósito: ver sourcebans.ts. */
const PANEL_BANS = process.env.panelBans ?? ''

const lambda = new LambdaClient({})

interface Evento {
  rawPath?: string
  headers?: Record<string, string | undefined>
  requestContext?: { http?: { method?: string; path?: string } }
}

// ---------------------------------------------------------------- stepper

/** Perfil ASLEEP añade la etapa de encendido al frente. NO existe un perfil instantáneo:
    un slot libre puede venir sucio de una partida anterior, así que siempre se reinicia. */
const ETAPAS = {
  ASLEEP: ['Despertando', 'Iniciando', 'Verificando', '¡Listo!'],
  AWAKE: ['Iniciando', 'Verificando', '¡Listo!'],
}

const CELDA: Record<string, { ASLEEP: number; AWAKE: number }> = {
  DESPERTANDO: { ASLEEP: 1, AWAKE: 1 },
  BOOTEANDO: { ASLEEP: 2, AWAKE: 1 },
  INICIANDO: { ASLEEP: 2, AWAKE: 1 },
  VERIFICANDO: { ASLEEP: 3, AWAKE: 2 },
  LISTO: { ASLEEP: 4, AWAKE: 3 },
}

function stepper(it: m.Intent) {
  const perfil = it.profile ?? 'AWAKE'
  const labels = ETAPAS[perfil]
  return { total: labels.length, current: CELDA[it.estado]?.[perfil] ?? 1, labels }
}

function intentPublico(it: m.Intent, posicionCola?: number, promovido?: boolean) {
  return {
    id: it.id,
    estado: it.estado,
    profile: it.profile,
    slotIndex: it.slotIndex,
    ...(it.estado === 'EN_COLA'
      ? { queue: { position: posicionCola ?? 1, promoted: Boolean(promovido) } }
      : { stepper: stepper(it) }),
    connectUrl: it.connectUrl,
    errorCode: it.errorCode,
    createdAt: it.createdAt,
  }
}

// ---------------------------------------------------------------- sesión

async function sesionDe(evento: Evento): Promise<Sesion | null> {
  const token = sesionDeCookies(evento.headers?.cookie ?? evento.headers?.Cookie)
  if (!token) return null
  return verificar(token, await secreto(SSM_JWT))
}

/** Pide el encendido de la máquina. El await NO es opcional: Lambda congela el proceso al
    devolver el handler y una promesa suelta puede quedarse sin salir, sin dejar rastro. */
async function pedirEncendido(): Promise<void> {
  if (!FN_WOL) return
  try {
    await lambda.send(new InvokeCommand({ FunctionName: FN_WOL, InvocationType: 'Event' }))
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'no se pudo pedir el encendido', e: String(e) }))
  }
}

// ---------------------------------------------------------------- estado

async function estado(sesion: Sesion | null) {
  const cfg = await m.config()
  const [h, listaSlots, laCola] = await Promise.all([m.host(), m.slots(cfg.n), m.cola()])

  const publicos = listaSlots.map((s) => ({
    index: s.index,
    estado: s.estado,
    ownerNick: s.ownerNick ?? undefined,
    ownerAvatar: s.ownerAvatar ?? undefined,
    /* En un slot libre la tarjeta anuncia "Próximo mapa", así que tiene que decir con qué
       arranca de verdad al reservarlo — no el último que se jugó ahí, que es lo que quedaba
       guardado y hacía que un slot libre prometiera un mapa que no iba a tocar. */
    map: (s.estado === 'ACTIVO' || s.estado === 'VACIO' || s.estado === 'PREPARANDO'
      ? s.map
      : cfg.startMap) ?? undefined,
    players: s.players,
    maxPlayers: s.maxPlayers ?? 8,
    since: s.since ?? undefined,
    // La dirección solo se da si hay algo a lo que conectarse.
    connect:
      s.estado === 'ACTIVO' || s.estado === 'VACIO'
        ? `steam://connect/${HOST_JUEGO}:${s.port}`
        : undefined,
  }))

  const base = {
    host: { state: h.state, since: h.lastHeartbeat },
    config: { n: cfg.n, reservasEnabled: cfg.reservasEnabled },
    slots: publicos,
    queue: { length: laCola.length },
    ts: Date.now(),
  }

  if (!sesion) return base

  const usuario = await obtener(sesion.steamId)
  const enCola = laCola.findIndex((e) => e.steamId === sesion.steamId)
  const miEntrada = enCola >= 0 ? laCola[enCola] : null

  let intent: m.Intent | null = null
  if (usuario?.intentActivo) {
    intent = await m.intentDe(sesion.steamId, usuario.intentActivo)
  }

  const mio = listaSlots.find((s) => s.ownerSteamId === sesion.steamId)

  return {
    ...base,
    me: {
      steamId: sesion.steamId,
      nick: sesion.nick,
      avatar: sesion.avatar,
      operador: sesion.operador,
      suspendido: usuario?.suspendido ?? false,
      intent: intent ? intentPublico(intent, enCola + 1, miEntrada?.estado === 'PROMOVIDO') : null,
      queue: {
        inQueue: enCola >= 0,
        position: enCola >= 0 ? enCola + 1 : null,
        promoted: miEntrada?.estado === 'PROMOVIDO',
        claimDeadline: miEntrada?.claimDeadline ?? null,
      },
      slot: mio
        ? {
            index: mio.index,
            connect: `steam://connect/${HOST_JUEGO}:${mio.port}`,
            players: mio.players,
            map: mio.map ?? undefined,
            emptySince: mio.emptySince ?? null,
          }
        : null,
    },
  }
}

// ---------------------------------------------------------------- reservar

async function reservar(sesion: Sesion) {
  const cfg = await m.config()
  const usuario = await obtener(sesion.steamId)

  if (usuario?.suspendido) return error('SUSPENDED', 'Tu cuenta está suspendida.')
  if (!cfg.reservasEnabled) {
    return error('RESERVAS_DISABLED', 'Las reservas están cerradas ahora mismo.')
  }

  /* Idempotencia: si ya hay una reserva viva se devuelve ESA, no se crea otra. Es lo que
     hace que un doble clic, o dos pestañas, no acaben con dos reservas. */
  if (usuario?.intentActivo) {
    const vivo = await m.intentDe(sesion.steamId, usuario.intentActivo)
    if (vivo && !m.esTerminal(vivo.estado)) {
      const laCola = await m.cola()
      const pos = laCola.findIndex((e) => e.steamId === sesion.steamId)
      const promovido = pos >= 0 && laCola[pos].estado === 'PROMOVIDO'
      // Salvo que sea reclamar un turno ya concedido: eso sí avanza.
      if (!(vivo.estado === 'EN_COLA' && promovido)) {
        return ok(intentPublico(vivo, pos + 1, promovido))
      }
    }
  }

  const h = await m.host()
  const listaSlots = await m.slots(cfg.n)
  const ahora = Date.now()
  const id = `int_${ahora.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

  /* Un servidor por persona, y la reserva entregada NO cuenta como cerrada.

     La comprobación de arriba mira si el intent sigue vivo, pero LISTO es un estado
     terminal —la reserva se cumplió—, así que quien ya tiene su servidor caía por el hueco
     y podía pedir un segundo. El candado de verdad es el slot: si ya hay uno a su nombre,
     ese es el suyo. */
  const yaTengo = listaSlots.find((s) => s.ownerSteamId === sesion.steamId)
  if (yaTengo?.intentId) {
    const suyo = await m.intentDe(sesion.steamId, yaTengo.intentId)
    if (suyo) return ok(intentPublico(suyo))
  }

  // Un slot guardado para mí por la cola tiene prioridad sobre los libres.
  const candidatos = [
    ...listaSlots.filter((s) => s.estado === 'RESERVADO_COLA' && s.claimSteamId === sesion.steamId),
    ...listaSlots.filter((s) => s.estado === 'LIBRE'),
  ]

  if (candidatos.length === 0) {
    const laCola = await m.cola()
    const ya = laCola.find((e) => e.steamId === sesion.steamId)
    const entrada = ya ?? (await m.entrarACola(sesion.steamId))
    const pos = (ya ? laCola.findIndex((e) => e.steamId === sesion.steamId) : laCola.length) + 1

    const it: m.Intent = {
      id, steamId: sesion.steamId, slotIndex: null, estado: 'EN_COLA',
      profile: null, connectUrl: null, errorCode: null,
      createdAt: ahora, updatedAt: ahora,
      stateDeadline: ahora + 6 * 3600_000, // la espera en cola no caduca sola tan pronto
    }
    await m.guardarIntent(it)
    await m.fijarIntentActivo(sesion.steamId, id)
    return ok(intentPublico(it, pos, entrada.estado === 'PROMOVIDO'))
  }

  // Se intenta reclamar en orden; si otro se adelantó, se prueba el siguiente.
  let reclamado: m.Slot | null = null
  for (const s of candidatos) {
    if (await m.reclamarSlot(s.index, id, sesion.steamId, sesion.nick, sesion.avatar)) {
      reclamado = s
      break
    }
  }
  if (!reclamado) {
    return error('CONFLICTO', 'Alguien se adelantó. Vuelve a intentarlo.')
  }

  /* Quien ya tiene slot no sigue en la cola. Olvidar esto tenía una consecuencia que no se
     ve a simple vista: el apagado automático exige la cola vacía, así que una entrada
     abandonada ahí lo desactivaba PARA SIEMPRE — desde la primera reserva servida desde la
     cola, la máquina no se volvía a apagar sola nunca. */
  const laCola = await m.cola()
  const miEntrada = laCola.find((e) => e.steamId === sesion.steamId)
  if (miEntrada) await m.salirDeCola(miEntrada.sk)

  /* "Dormida" se decide por la FRESCURA DEL LATIDO, no por el `state` guardado.

     Nadie escribe nunca 'DOWN' en la tabla: el estado solo lo ponen el latido ('UP') y el
     encendido ('WAKING'), y la caída se deduce al leer. Eso deja una ventana —desde que la
     máquina se apaga hasta que su último latido caduca— en la que el campo dice 'UP' y es
     mentira. Reservar ahí daba por despierta una máquina apagada: no se mandaba el paquete
     de encendido y la reserva moría de plazo sin que nadie hubiera intentado nada. Y es
     justo cuando el usuario reserva, porque la web también la muestra encendida. */
  const dormida = !m.despiertaDeVerdad(h)
  const it: m.Intent = {
    id,
    steamId: sesion.steamId,
    slotIndex: reclamado.index,
    estado: dormida ? 'DESPERTANDO' : 'BOOTEANDO',
    profile: dormida ? 'ASLEEP' : 'AWAKE',
    connectUrl: null,
    errorCode: null,
    createdAt: ahora,
    updatedAt: ahora,
    stateDeadline: ahora + (dormida ? 240_000 : 90_000),
  }
  await m.guardarIntent(it)
  await m.fijarIntentActivo(sesion.steamId, id)

  /* La orden de levantar se deja encolada AHORA, esté la máquina despierta o dormida. Si
     está dormida se quedará esperando hasta que el agente arranque y pase a recogerla, que
     es justo lo que se quiere: no hay que acordarse de mandarla después.

     Va con el SteamID de quien reserva, porque levantar el servidor y darle el mando son la
     misma operación desde fuera. */
  await m.encolarOrden({
    tipo: 'LEVANTAR',
    slotIndex: reclamado.index,
    adminSteamId: sesion.steamId,
  })

  // Si el barrido había decidido apagar y la orden sigue sin recoger, ya no vale.
  await m.cancelarApagado()

  if (dormida) {
    await m.marcarDespertando()

    /* El await NO es opcional aunque la invocación sea asíncrona. Lambda congela el proceso
       en cuanto el handler devuelve, y una promesa suelta se queda a medias: la petición a
       la API de Lambda puede no haber salido siquiera. El resultado sería el peor posible —
       el paquete de encendido no se manda y en los registros no aparece ningún error.

       Esperar cuesta unos milisegundos: InvocationType 'Event' solo encola, no espera a que
       el WoL termine. Quien tarda minutos es la máquina, no esta llamada. */
    // No se aborta la reserva si falla: el barrido reintenta el encendido cada minuto.
    await pedirEncendido()
  }

  return ok(intentPublico(it))
}

// ---------------------------------------------------------------- cerrar

async function cerrar(sesion: Sesion) {
  const cfg = await m.config()
  const listaSlots = await m.slots(cfg.n)
  const mio = listaSlots.find((s) => s.ownerSteamId === sesion.steamId)

  /* La reserva se marca terminal SIEMPRE, tenga slot o no. Si se dejara viva seguiría en el
     índice de pendientes con su slotIndex apuntando a un servidor que ya no es suyo, y el
     barrido acabaría liberándoselo a quien lo tenga entonces. */
  const usuario = await obtener(sesion.steamId)
  if (usuario?.intentActivo) {
    const it = await m.intentDe(sesion.steamId, usuario.intentActivo)
    if (it && !m.esTerminal(it.estado)) {
      await m.guardarIntent({ ...it, estado: 'CANCELADO', updatedAt: Date.now() })
    }
  }

  if (mio) {
    // Se para el servidor además de soltar el slot: si no, seguiría corriendo para nadie y
    // la máquina no llegaría nunca a apagarse.
    // Forzada: la pidió el dueño. El agente avisa por el chat, espera unos segundos y saca
    // a quien esté dentro, en vez de cancelar la parada por haber gente.
    await m.encolarOrden({ tipo: 'PARAR', slotIndex: mio.index, forzado: true })
    await m.liberarSlot(mio.index)
    await m.fijarIntentActivo(sesion.steamId, null)
    return ok({ ok: true, closed: { slotIndex: mio.index } })
  }

  await m.fijarIntentActivo(sesion.steamId, null)

  const laCola = await m.cola()
  const mia = laCola.find((e) => e.steamId === sesion.steamId)
  if (mia) await m.salirDeCola(mia.sk)

  return ok({ ok: true })
}

// ---------------------------------------------------------------- entrada

export async function handler(evento: Evento) {
  if (!vieneDeCloudFront(evento.headers ?? {})) {
    return error('UNAUTHORIZED', 'Acceso no autorizado.')
  }

  const ruta = evento.requestContext?.http?.path ?? evento.rawPath ?? ''
  const metodo = evento.requestContext?.http?.method ?? 'GET'
  const sesion = await sesionDe(evento)

  try {
    // El estado es público: sin sesión se ve la flota, solo que sin el bloque personal.
    /* El panel de baneos va antes de la comprobación de sesión: tiene su propia respuesta
       para cada caso (sin sesión, sin permiso, máquina apagada) y no es una ruta de API. */
    if (ruta.endsWith('/sourcebans') && metodo === 'GET') {
      return puertaSourcebans(sesion, PANEL_BANS, `https://${process.env.domain}`, pedirEncendido)
    }

    if (ruta.endsWith('/api/state') && metodo === 'GET') return ok(await estado(sesion))

    if (!sesion) return error('UNAUTHORIZED', 'Necesitas iniciar sesión.')

    if (ruta.endsWith('/api/reserve') && metodo === 'POST') return reservar(sesion)
    if (ruta.endsWith('/api/close') && metodo === 'POST') return cerrar(sesion)
    if (ruta.endsWith('/api/queue/leave') && metodo === 'POST') return cerrar(sesion)
    if (ruta.endsWith('/api/me') && metodo === 'GET') {
      const e = await estado(sesion)
      return ok('me' in e ? e.me : null)
    }

    return error('NOT_FOUND', 'Ruta desconocida.')
  } catch (e) {
    console.error(JSON.stringify({ msg: 'fallo en la API', ruta, e: String(e) }))
    return error('UNKNOWN', 'Algo salió mal por nuestro lado.')
  }
}
