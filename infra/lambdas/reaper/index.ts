/* Barrido periódico: corre cada minuto y arregla lo que se quedó a medias.

   Existe porque el sistema depende de una máquina que puede no responder: si el encendido
   falla, si el agente muere a mitad de una orden, o si alguien cierra el navegador con un
   turno concedido, sin esto quedarían reservas colgadas para siempre y slots bloqueados.

   Un minuto es el mínimo que permite un horario recurrente, y basta: los plazos del sistema
   son de decenas de segundos a minutos. */

import * as m from '../shared/modelo'
import { obtener } from '../shared/usuarios'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'

const FN_WOL = process.env.wolFunction
const lambda = new LambdaClient({})

/** Tras enviar el paquete de encendido se espera antes de reintentar: la tarjeta de red
    tarda entre 15 y 30 segundos en quedar en modo escucha después de apagar, así que
    insistir de inmediato no sirve de nada. */
const ESPERA_REINTENTO_WOL_MS = 45_000

async function caducarReservasColgadas(): Promise<number> {
  const vencidos = await m.intentsVencidos()
  let n = 0

  for (const it of vencidos) {
    if (m.esTerminal(it.estado)) continue

    // Una reserva en cola no caduca por plazo: espera lo que haga falta.
    if (it.estado === 'EN_COLA') continue

    await m.guardarIntent({
      ...it,
      estado: 'FALLIDO',
      errorCode: `TIMEOUT_${it.estado}`,
      updatedAt: Date.now(),
    })
    if (it.slotIndex) {
      // Condicional a propósito: si el slot ya pasó a otra persona, no se toca.
      const eraSuyo = await m.liberarSlotDe(it.slotIndex, it.id)
      // Y se manda pararlo: sin esto queda un srcds huérfano corriendo para nadie, que
      // además cuenta como "algo en marcha" y estorba al apagado.
      if (eraSuyo) await m.encolarOrden({ tipo: 'PARAR', slotIndex: it.slotIndex })
    }
    await m.soltarIntentActivo(it.steamId, it.id)
    n++
    console.info(JSON.stringify({ msg: 'reserva caducada', id: it.id, estaba: it.estado }))
  }
  return n
}

async function expirarTurnos(cfg: m.Config): Promise<number> {
  const listaSlots = await m.slots(cfg.n)
  const ahora = Date.now()
  let n = 0

  for (const s of listaSlots) {
    if (s.estado !== 'RESERVADO_COLA') continue
    if (!s.claimDeadline || s.claimDeadline > ahora) continue

    // No entró a tiempo: el slot vuelve a estar libre y su sitio pasa al siguiente.
    const laCola = await m.cola()
    const suya = laCola.find((e) => e.steamId === s.claimSteamId)
    if (suya) await m.salirDeCola(suya.sk)
    if (s.claimSteamId) await m.fijarIntentActivo(s.claimSteamId, null)

    await m.liberarSlot(s.index)
    n++
    console.info(JSON.stringify({ msg: 'turno expirado', slot: s.index, de: s.claimSteamId }))
  }
  return n
}

/** Cierra los servidores que llevan vacíos más de lo permitido.

   Es lo que hace que una reserva olvidada no bloquee un slot para siempre. El reloj lo lleva
   `emptySince`, que el agente refresca en cada latido: se pone al ver el servidor vacío y se
   borra en cuanto entra alguien, así que solo cuenta el vacío continuo. */
async function cerrarVacios(cfg: m.Config, pendientes: m.Orden[]): Promise<number> {
  // Sin agente al otro lado, `emptySince` es una foto vieja que no deja de envejecer sola.
  // Cerrar por ella sería cerrar por una ausencia que nadie ha comprobado.
  const h = await m.host()
  if (!m.despiertaDeVerdad(h)) return 0

  const listaSlots = await m.slots(cfg.n)
  const ahora = Date.now()
  let n = 0

  for (const s of listaSlots) {
    if (s.estado !== 'ACTIVO' && s.estado !== 'VACIO') continue
    if (!s.emptySince || ahora - s.emptySince < cfg.emptyCloseSec * 1000) continue
    // Si el agente aún no ha recogido la orden de parar, no se apila otra.
    if (pendientes.some((o) => o.tipo === 'PARAR' && o.slotIndex === s.index)) continue

    // Primero la orden, después soltar el slot: al revés, alguien podría reservarlo entre
    // ambas escrituras y recibiría un servidor que está a punto de pararse.
    await m.encolarOrden({ tipo: 'PARAR', slotIndex: s.index })

    if (s.ownerSteamId) {
      const usuario = await obtener(s.ownerSteamId)
      if (usuario?.intentActivo) {
        const it = await m.intentDe(s.ownerSteamId, usuario.intentActivo)
        if (it && !m.esTerminal(it.estado)) {
          await m.guardarIntent({ ...it, estado: 'EXPIRADO', updatedAt: ahora })
        }
      }
      await m.fijarIntentActivo(s.ownerSteamId, null)
    }

    await m.liberarSlot(s.index)
    n++
    console.info(
      JSON.stringify({ msg: 'servidor vacío cerrado', slot: s.index, vacioMs: ahora - s.emptySince }),
    )
  }
  return n
}

/** Apaga la máquina cuando ya nada la sostiene.

   Los sostenes son cuatro, y basta uno para seguir encendida: gente jugando, alguna reserva
   en marcha, alguien esperando en la cola, o una sesión SSH abierta (para no cortarle la
   conexión al operador a media faena). El apagado es inmediato porque encender cuesta
   segundos: no compensa dejar la máquina esperando por si acaso.

   El sostén que manda es la GENTE, no el estado del slot. Un servidor puede quedar corriendo
   con jugadores dentro después de que su reserva se cerró: el slot dice LIBRE y aun así hay
   partida en curso. Mirar solo el estado apagaría la máquina en mitad de esa partida. */
async function apagarSiNadieSostiene(cfg: m.Config, pendientes: m.Orden[]): Promise<boolean> {
  if (!cfg.apagadoAutomatico) return false

  const h = await m.host()
  if (!m.despiertaDeVerdad(h)) return false

  const [listaSlots, laCola] = await Promise.all([m.slots(cfg.n), m.cola()])
  const sostenida =
    Boolean(h.sshActive) ||
    listaSlots.some((s) => (s.players ?? 0) > 0) ||
    listaSlots.some((s) => s.estado !== 'LIBRE') ||
    laCola.length > 0

  if (sostenida) {
    /* Algo la sostiene AHORA. Si quedaba un apagado decidido cuando no era así, se retira:
       una orden vieja describe una situación que ya no existe, y el agente podría recogerla
       minutos después y apagar la máquina con alguien dentro. */
    const retiradas = await m.cancelarApagado()
    if (retiradas) {
      console.info(JSON.stringify({ msg: 'apagado retirado: algo volvió a sostener la máquina' }))
    }
    return false
  }

  // Con órdenes sin recoger todavía hay trabajo pendiente: apagar ahora las perdería. Y si
  // ya hay un APAGAR en la cola, no se apila otro. Las que se atascan las caduca el barrido.
  if (pendientes.length > 0) return false

  await m.encolarOrden({ tipo: 'APAGAR' })
  console.info(JSON.stringify({ msg: 'apagado pedido: nada sostiene la máquina' }))
  return true
}

async function promoverSiHaySitio(cfg: m.Config): Promise<number> {
  const laCola = await m.cola()
  if (!laCola.some((e) => e.estado === 'ESPERANDO')) return 0

  const listaSlots = await m.slots(cfg.n)
  const libre = listaSlots.find((s) => s.estado === 'LIBRE')
  if (!libre) return 0

  const promovido = await m.promoverPrimero(libre.index, cfg.claimWindowSec)
  if (promovido) {
    console.info(JSON.stringify({ msg: 'turno concedido', slot: libre.index, a: promovido.steamId }))
    return 1
  }
  return 0
}

/** Si alguien espera a que la máquina despierte y no da señales, se manda otro paquete.

   La condición NO es "está en WAKING". Ese estado solo lo pone `marcarDespertando()`, y hay
   un camino entero que no pasa por ahí: cuando la máquina se apaga, su `state` guardado
   sigue diciendo 'UP' hasta que el latido caduca, así que una reserva hecha en esa ventana
   la daba por despierta y nunca llamaba al encendido. Con la condición vieja, el reintento
   tampoco entraba —el estado saltaba de 'UP' a 'DOWN' sin tocar 'WAKING'— y la reserva moría
   de plazo sin que se hubiera emitido un solo paquete.

   Lo que de verdad importa es esto: hay alguien esperando y la máquina no contesta. */
async function reintentarEncendido(cfg: m.Config): Promise<boolean> {
  const h = await m.host()
  if (m.despiertaDeVerdad(h)) return false

  // ¿Espera alguien? Un slot tomado significa reserva en marcha.
  const listaSlots = await m.slots(cfg.n)
  const esperando = listaSlots.some((s) => s.estado === 'PREPARANDO')
  if (!esperando && h.state !== 'WAKING') return false

  const desdeUltimo = Date.now() - (h.lastWolSentAt ?? 0)
  if (desdeUltimo < ESPERA_REINTENTO_WOL_MS) return false

  if (!FN_WOL) return false
  await lambda.send(new InvokeCommand({ FunctionName: FN_WOL, InvocationType: 'Event' }))
  await m.marcarDespertando()
  console.info(JSON.stringify({ msg: 'reintento de encendido', desdeUltimoMs: desdeUltimo }))
  return true
}

export async function handler() {
  const cfg = await m.config()

  /* Lo primero, tirar las órdenes viejas. Una que nadie recogió describe una situación que
     ya no existe, y mientras siga en la cola bloquea el apagado automático —que exige la
     cola vacía. Sin esta limpieza, una sola orden atascada lo desactivaba para siempre. */
  const ordenesViejas = await m.caducarOrdenes()
  const pendientes = await m.ordenesPendientes()

  /* El resto va en este orden: primero se libera todo lo caducado, y solo después se
     reparte, para que un slot que acaba de quedar libre pueda ir al siguiente de la cola en
     esta misma pasada. El apagado va el último: necesita ver el resultado de todo lo
     anterior para saber si de verdad no queda nadie. */
  const caducadas = await caducarReservasColgadas()
  const expirados = await expirarTurnos(cfg)
  const vacios = await cerrarVacios(cfg, pendientes)
  const promovidos = await promoverSiHaySitio(cfg)
  const reintento = await reintentarEncendido(cfg)
  const apagado = await apagarSiNadieSostiene(cfg, await m.ordenesPendientes())

  // Solo se deja rastro si hubo algo que hacer: con un minuto de cadencia, registrar cada
  // pasada vacía serían 43.000 líneas al mes que no dicen nada.
  if (caducadas || expirados || vacios || promovidos || reintento || apagado || ordenesViejas) {
    console.info(
      JSON.stringify({ msg: 'barrido', ordenesViejas, caducadas, expirados, vacios, promovidos, reintento, apagado }),
    )
  }

  return { ordenesViejas, caducadas, expirados, vacios, promovidos, reintento, apagado }
}
