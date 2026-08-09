/* Acceso a datos: configuración, máquina anfitriona, slots y cola.

   Todo vive en una sola tabla. Las claves siguen el diseño de docs/tecnico/01-datos.md. */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLA } from './ddb'

// ---------------------------------------------------------------- tipos

export type EstadoHost = 'DOWN' | 'WAKING' | 'UP'

export type EstadoSlot =
  | 'LIBRE' | 'PREPARANDO' | 'ACTIVO' | 'VACIO' | 'RESERVADO_COLA' | 'CERRANDO' | 'ERROR'

export type EstadoIntent =
  | 'SOLICITADO' | 'EN_COLA' | 'DESPERTANDO' | 'BOOTEANDO' | 'INICIANDO'
  | 'VERIFICANDO' | 'LISTO' | 'FALLIDO' | 'CANCELADO' | 'EXPIRADO'

export const TERMINALES: EstadoIntent[] = ['LISTO', 'FALLIDO', 'CANCELADO', 'EXPIRADO']
export const esTerminal = (e: EstadoIntent) => TERMINALES.includes(e)

export interface Config {
  n: number
  reservasEnabled: boolean
  maxWakesPerDay: number
  cooldownSec: number
  claimWindowSec: number
  emptyCloseSec: number
  /** Mapa con el que arranca un servidor recién levantado. Es lo que de verdad le tocará
     a quien reserve, y por tanto lo que debe decir la tarjeta de un slot libre. */
  startMap: string
  /** Interruptor de seguridad: con false la máquina no se apaga sola nunca.

     Existe porque apagarse es lo único que este sistema hace y no puede deshacer por su
     cuenta: si el router no sabe entregar el paquete de encendido con el equipo apagado
     —le falta el enlace fijo IP↔MAC—, la máquina se apaga y ya no vuelve sin que alguien
     esté delante. Poniéndolo a false se conserva todo lo demás (reservas, cola, cierre de
     servidores vacíos) mientras se arregla la red. */
  apagadoAutomatico: boolean
}

export interface Host {
  state: EstadoHost
  lastHeartbeat: number
  publicIp?: string
  wakeStartedAt?: number | null
  lastWolSentAt?: number | null
  sourcebansLastUsed?: number
  sshActive?: boolean
  /** Modo Wake-on-LAN que reporta la tarjeta: 'g' = escuchando el paquete mágico, 'd' =
     desactivada. Si al apagarse no era 'g', la máquina no va a poder despertar. */
  wolArmado?: string
}

export interface Slot {
  index: number
  port: number
  estado: EstadoSlot
  ownerSteamId?: string | null
  ownerNick?: string | null
  ownerAvatar?: string | null
  intentId?: string | null
  since?: number | null
  emptySince?: number | null
  map?: string | null
  players?: number
  bots?: number
  maxPlayers?: number
  nombres?: string[]
  claimSteamId?: string | null
  claimDeadline?: number | null
  updatedAt: number
}

export interface Intent {
  id: string
  steamId: string
  slotIndex: number | null
  estado: EstadoIntent
  profile: 'AWAKE' | 'ASLEEP' | null
  connectUrl: string | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
  stateDeadline: number
}

export interface EntradaCola {
  steamId: string
  joinedAt: number
  estado: 'ESPERANDO' | 'PROMOVIDO'
  slotIndex?: number | null
  claimDeadline?: number | null
  sk: string
}

// ---------------------------------------------------------------- config

const CONFIG_POR_DEFECTO: Config = {
  n: Number(process.env.serversDefault ?? 4),
  reservasEnabled: true,
  maxWakesPerDay: 20,
  cooldownSec: 20,
  claimWindowSec: 180,
  emptyCloseSec: 900,
  startMap: 'c1m1_hotel',
  apagadoAutomatico: true,
}

/** La N viva la decide el operador y vive aquí, NO en la configuración del despliegue.
    Si el item no existe todavía, se siembra con los valores por defecto. */
export async function config(): Promise<Config> {
  const r = await ddb.send(new GetCommand({ TableName: TABLA, Key: { PK: 'CONFIG', SK: 'CONFIG' } }))
  return { ...CONFIG_POR_DEFECTO, ...(r.Item ?? {}) } as Config
}

// ---------------------------------------------------------------- host

const CLAVE_HOST = { PK: 'HOST#home', SK: 'HOST#home' }

/** Se considera viva si dio señales hace poco. Sin latido reciente, está apagada:
    no hace falta preguntárselo a nadie. */
const MARGEN_LATIDO_MS = 90_000

export async function host(): Promise<Host> {
  const r = await ddb.send(new GetCommand({ TableName: TABLA, Key: CLAVE_HOST }))
  const h = (r.Item as Host | undefined) ?? { state: 'DOWN', lastHeartbeat: 0 }

  // El estado guardado puede estar obsoleto: manda el latido.
  if (h.state === 'UP' && Date.now() - h.lastHeartbeat > MARGEN_LATIDO_MS) {
    return { ...h, state: 'DOWN' }
  }
  return h
}

export async function marcarDespertando(): Promise<void> {
  const ahora = Date.now()
  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: CLAVE_HOST,
      UpdateExpression: 'SET #s = :waking, wakeStartedAt = :ahora, lastWolSentAt = :ahora',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':waking': 'WAKING', ':ahora': ahora },
    }),
  )
}

// ---------------------------------------------------------------- slots

const clave = (i: number) => ({ PK: `SLOT#${i}`, SK: `SLOT#${i}` })
const PUERTO_BASE = 6032

export async function slots(n: number): Promise<Slot[]> {
  const leidos = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      ddb.send(new GetCommand({ TableName: TABLA, Key: clave(i + 1) })),
    ),
  )

  return leidos.map((r, i) => {
    const index = i + 1
    // Los valores base van SIEMPRE debajo del item, no solo cuando falta: un slot del que aún
    // no hay item es un slot libre, y uno guardado a medias no debe llegar a la API sin
    // identidad. La lista que se devuelve tiene siempre `n` slots completos.
    return {
      index,
      port: PUERTO_BASE + index,
      estado: 'LIBRE' as EstadoSlot,
      updatedAt: 0,
      ...((r.Item as Partial<Slot> | undefined) ?? {}),
    } as Slot
  })
}

/** Reclama un slot para un intent. La condición es lo que impide que dos personas se
    lleven el mismo: si otro llegó primero, la escritura falla y hay que buscar otro. */
export async function reclamarSlot(
  index: number,
  intentId: string,
  steamId: string,
  nick: string,
  avatar?: string,
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLA,
        Key: clave(index),
        UpdateExpression: [
          'SET #e = :prep, intentId = :iid, ownerSteamId = :sid, ownerNick = :nick, ownerAvatar = :av',
          // El reloj de vacío se pone a cero al tomar el slot. Si se arrastrara el del
          // inquilino anterior, el barrido cerraría esta reserva nada más entregarla.
          '#idx = :idx, port = :port, updatedAt = :ahora REMOVE emptySince',
        ].join(', '),
        // Solo si sigue libre (o no existe todavía).
        ConditionExpression: 'attribute_not_exists(PK) OR #e = :libre OR (#e = :reservado AND claimSteamId = :sid)',
        ExpressionAttributeNames: { '#e': 'estado', '#idx': 'index' },
        ExpressionAttributeValues: {
          ':prep': 'PREPARANDO',
          ':libre': 'LIBRE',
          ':reservado': 'RESERVADO_COLA',
          ':iid': intentId,
          ':sid': steamId,
          ':nick': nick,
          ':av': avatar ?? null,
          ':idx': index,
          ':port': PUERTO_BASE + index,
          ':ahora': Date.now(),
        },
      }),
    )
    return true
  } catch {
    return false // otro se lo llevó
  }
}

/** Libera el slot SOLO si sigue siendo de ese intent.

   La condición es lo que impide el peor error del sistema: una reserva vieja que caduca y,
   al limpiar, le quita el servidor a quien lo tiene ahora. Entre que una reserva se abandona
   y el barrido la caduca pueden pasar minutos, y en ese hueco el slot ya pudo pasar a otra
   persona — liberarlo entonces sería echarla de su propia partida. */
export async function liberarSlotDe(index: number, intentId: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLA,
        Key: clave(index),
        UpdateExpression:
          'SET #e = :libre, updatedAt = :ahora REMOVE ownerSteamId, ownerNick, ownerAvatar, intentId, since, #conn, claimSteamId, claimDeadline, emptySince',
        ConditionExpression: 'intentId = :iid',
        ExpressionAttributeNames: { '#e': 'estado', '#conn': 'connect' },
        ExpressionAttributeValues: { ':libre': 'LIBRE', ':ahora': Date.now(), ':iid': intentId },
      }),
    )
    return true
  } catch {
    return false // ya no es suyo: se deja en paz
  }
}

export async function liberarSlot(index: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: clave(index),
      UpdateExpression:
        // emptySince entra en el REMOVE: si no, el siguiente en ocupar el slot heredaría el
        // cronómetro de vacío del anterior y se le cerraría el servidor antes de tiempo.
        'SET #e = :libre, updatedAt = :ahora REMOVE ownerSteamId, ownerNick, ownerAvatar, intentId, since, #conn, claimSteamId, claimDeadline, emptySince',
      // `connect` es palabra reservada de DynamoDB: sin el alias, la expresión entera se
      // rechaza y liberar un slot falla siempre.
      ExpressionAttributeNames: { '#e': 'estado', '#conn': 'connect' },
      ExpressionAttributeValues: { ':libre': 'LIBRE', ':ahora': Date.now() },
    }),
  )
}

// ---------------------------------------------------------------- intents

export async function intentDe(steamId: string, id: string): Promise<Intent | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: TABLA, Key: { PK: `USER#${steamId}`, SK: `INTENT#${id}` } }),
  )
  return (r.Item as Intent | undefined) ?? null
}

export async function guardarIntent(it: Intent): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLA,
      Item: {
        PK: `USER#${it.steamId}`,
        SK: `INTENT#${it.id}`,
        ...it,
        // El índice solo lleva los intents vivos, para que el barrido periódico no tenga
        // que recorrer la tabla entera buscando plazos vencidos.
        ...(esTerminal(it.estado)
          ? {}
          : { GSI1PK: 'INTENT_ACTIVO', GSI1SK: `${it.stateDeadline}#${it.id}` }),
      },
    }),
  )
}

/** Puntero al intent activo del usuario: es el candado de "una reserva por persona". */
export async function fijarIntentActivo(steamId: string, id: string | null): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: { PK: `USER#${steamId}`, SK: 'PROFILE' },
      UpdateExpression: id ? 'SET intentActivo = :id' : 'REMOVE intentActivo',
      ...(id ? { ExpressionAttributeValues: { ':id': id } } : {}),
    }),
  )
}

/** Suelta el intent activo SOLO si sigue siendo el que se cree.

   El barrido limpia reservas viejas, y entre que una caduca y le llega el turno de limpiarla
   el usuario pudo hacer otra. Borrar el puntero a ciegas dejaba la reserva NUEVA huérfana:
   existía, tenía su slot y su orden encolada, pero /api/state la devolvía como si no hubiera
   nada — invisible en la pantalla mientras ocupaba un servidor. */
export async function soltarIntentActivo(steamId: string, id: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLA,
        Key: { PK: `USER#${steamId}`, SK: 'PROFILE' },
        UpdateExpression: 'REMOVE intentActivo',
        ConditionExpression: 'intentActivo = :id',
        ExpressionAttributeValues: { ':id': id },
      }),
    )
  } catch {
    // Ya apunta a otra cosa: es de otra reserva, no se toca.
  }
}

// ---------------------------------------------------------------- cola

/** FIFO por orden de llegada: la clave lleva el instante, así la consulta ya sale ordenada. */
const skCola = (joinedAt: number, steamId: string) =>
  `POS#${String(joinedAt).padStart(16, '0')}#${steamId}`

export async function cola(): Promise<EntradaCola[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLA,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': 'QUEUE', ':sk': 'POS#' },
      ScanIndexForward: true,
    }),
  )
  return (r.Items ?? []).map((i) => ({ ...i, sk: i.SK }) as EntradaCola)
}

export async function entrarACola(steamId: string): Promise<EntradaCola> {
  const joinedAt = Date.now()
  const entrada: EntradaCola = { steamId, joinedAt, estado: 'ESPERANDO', sk: skCola(joinedAt, steamId) }
  await ddb.send(
    new PutCommand({
      TableName: TABLA,
      Item: { PK: 'QUEUE', SK: entrada.sk, ...entrada },
    }),
  )
  return entrada
}

export async function salirDeCola(sk: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLA, Key: { PK: 'QUEUE', SK: sk } }))
}

// ---------------------------------------------------------------- órdenes para el agente

export type TipoOrden = 'LEVANTAR' | 'PARAR' | 'APAGAR'

export interface Orden {
  id: string
  tipo: TipoOrden
  slotIndex?: number
  /** Una parada FORZADA la pidió el dueño desde la web. A diferencia del cierre por
     inactividad, esta no se cancela porque haya gente dentro: se les avisa y se les saca. */
  forzado?: boolean
  /** SteamID de quien será admin en ese servidor. */
  adminSteamId?: string
  creadaEn: number
  ttl: number
}

/** Las órdenes se apilan y el agente se las lleva al consultar. Llevan identificador para
    que ejecutar dos veces la misma sea inofensivo: si el agente confirma tarde y vuelve a
    recibirla, la reconoce y no repite el trabajo. */
export async function encolarOrden(o: Omit<Orden, 'id' | 'creadaEn' | 'ttl'>): Promise<Orden> {
  const ahora = Date.now()
  const orden: Orden = {
    ...o,
    id: `cmd_${ahora.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    creadaEn: ahora,
    // Si nadie la recoge en una hora, sobra: la máquina estaba apagada o el agente muerto.
    ttl: Math.floor(ahora / 1000) + 3600,
  }
  await ddb.send(
    new PutCommand({ TableName: TABLA, Item: { PK: 'CMD', SK: `CMD#${orden.id}`, ...orden } }),
  )
  return orden
}

export async function ordenesPendientes(): Promise<Orden[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLA,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': 'CMD', ':sk': 'CMD#' },
      ScanIndexForward: true,
    }),
  )
  // Se devuelven solo los campos de la orden: las claves de la tabla y el TTL son cocina
  // interna, y el agente no debe llegar a depender de ellas.
  return (r.Items ?? []).map((i) => ({
    id: i.id,
    tipo: i.tipo,
    slotIndex: i.slotIndex,
    forzado: i.forzado,
    adminSteamId: i.adminSteamId,
    creadaEn: i.creadaEn,
    ttl: i.ttl,
  })) as Orden[]
}

/** Retira las órdenes de apagado que sigan pendientes.

   Se llama al reservar y en cada barrido que encuentre algo sosteniendo la máquina. Sin
   esto quedaría una carrera fea: el barrido decide apagar porque no había nadie, y antes de
   que el agente recoja la orden llega una reserva. El agente también se defiende por su
   cuenta, pero es mejor que la orden ni siquiera le llegue. */
export async function cancelarApagado(): Promise<number> {
  const pendientes = await ordenesPendientes()
  const apagados = pendientes.filter((o) => o.tipo === 'APAGAR')
  await Promise.all(apagados.map((o) => borrarOrden(o.id)))
  return apagados.length
}

/** Vida máxima de una orden en la cola. El TTL de DynamoDB no sirve para esto: borra los
    items cuando le viene bien —puede tardar días— y mientras tanto los sigue devolviendo en
    las consultas. Así que la caducidad se aplica al leer. */
const VIDA_ORDEN_MS = 30 * 60_000

/** Tira las órdenes que llevan demasiado tiempo sin que nadie las recoja.

   Importa por dos motivos: una orden vieja describe una situación que ya no existe, y
   mientras siga en la cola bloquea el apagado automático —que exige la cola vacía para no
   apagar la máquina con trabajo pendiente. Sin esta limpieza, una sola orden atascada
   desactiva el apagado para siempre y sin dejar rastro. */
export async function caducarOrdenes(): Promise<number> {
  const pendientes = await ordenesPendientes()
  const limite = Date.now() - VIDA_ORDEN_MS
  const viejas = pendientes.filter((o) => o.creadaEn < limite)
  await Promise.all(viejas.map((o) => borrarOrden(o.id)))
  return viejas.length
}

export async function borrarOrden(id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLA, Key: { PK: 'CMD', SK: `CMD#${id}` } }))
}

/** Lo que el agente reporta de cada servidor en cada latido.

   `respondio` distingue "contesté y no hay nadie" de "no contestó". Parece un matiz y no lo
   es: sobre "no hay nadie" se cierran servidores y se apaga la máquina, así que confundir
   un datagrama perdido con un servidor desierto echa a la gente de su partida. */
export interface ReporteSlot {
  index: number
  corriendo: boolean
  respondio?: boolean
  map?: string
  players?: number
  bots?: number
  maxPlayers?: number
  /** Quiénes están dentro, bots incluidos. Solo para enseñarlo; nada se decide con esto. */
  nombres?: string[]
  pluginsOk?: boolean
  adminSembrado?: boolean
}

export async function guardarLatido(datos: {
  publicIp?: string
  sshActive?: boolean
  sourcebansLastUsed?: number
  wolArmado?: string
}): Promise<void> {
  const ahora = Date.now()
  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: CLAVE_HOST,
      UpdateExpression:
        'SET #s = :up, lastHeartbeat = :ahora, publicIp = :ip, sshActive = :ssh, wolArmado = :wol REMOVE wakeStartedAt',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: {
        ':up': 'UP',
        ':ahora': ahora,
        ':ip': datos.publicIp ?? null,
        ':ssh': datos.sshActive ?? false,
        ':wol': datos.wolArmado ?? null,
      },
    }),
  )
}

/** Vuelca a la tabla lo que el agente ve de un servidor.

   Los `if_not_exists` no son adorno. El caso normal es que el agente reporte un servidor que
   nadie ha reservado, y como esto es un UPDATE, DynamoDB crea el item con SOLO lo que se
   escriba aquí: sin ellos el slot nacería sin `index`, sin `port` y sin `estado`, y la API
   devolvería tarjetas sin identidad. Con ellos un item nuevo nace completo, y uno que ya
   existe conserva su estado real (PREPARANDO, ACTIVO…) sin que el agente lo pise.

   `emptySince` es el reloj del cierre automático: se pone al ver el servidor vacío y se borra
   en cuanto entra alguien, así que solo cuenta el vacío continuo. Si alguien entra y sale, el
   reloj arranca de nuevo. */
export async function actualizarSlotDesdeAgente(r: ReporteSlot): Promise<void> {
  const ahora = Date.now()

  /* Si el servidor corre pero no contestó, NO se toca nada de lo que se decide con ello:
     ni el número de jugadores ni el reloj de vacío. Escribir players=0 ahí convertiría un
     paquete perdido en "está desierto", y sobre eso se cierra el servidor y se apaga la
     máquina. Se prefiere el dato viejo —que al menos fue cierto— a uno inventado. */
  const mudo = r.corriendo && r.respondio === false

  const asignaciones = [
    'updatedAt = :ahora',
    '#idx = if_not_exists(#idx, :idx)',
    'port = if_not_exists(port, :port)',
    '#e = if_not_exists(#e, :libre)',
  ]
  const valores: Record<string, unknown> = {
    ':ahora': ahora,
    ':idx': r.index,
    ':port': PUERTO_BASE + r.index,
    ':libre': 'LIBRE' as EstadoSlot,
  }
  const nombres: Record<string, string> = { '#idx': 'index', '#e': 'estado' }
  let quitar = ''

  if (!mudo) {
    asignaciones.push('#m = :map, players = :pl, bots = :bots, maxPlayers = :mx, nombres = :nom')
    nombres['#m'] = 'map'
    valores[':map'] = r.map ?? null
    valores[':pl'] = r.players ?? 0
    valores[':bots'] = r.bots ?? 0
    valores[':mx'] = r.maxPlayers ?? 8
    valores[':nom'] = r.nombres ?? []

    // El reloj de vacío se pone al ver el servidor sin gente y se borra en cuanto entra
    // alguien, así que solo cuenta el vacío continuo.
    if ((r.players ?? 0) === 0) asignaciones.push('emptySince = if_not_exists(emptySince, :ahora)')
    else quitar = ' REMOVE emptySince'
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: clave(r.index),
      UpdateExpression: `SET ${asignaciones.join(', ')}${quitar}`,
      ExpressionAttributeNames: nombres,
      ExpressionAttributeValues: valores,
    }),
  )
}

/** El agente avisa justo antes de apagarse. Sin esto, la nube seguiría viendo la máquina
    encendida durante minuto y medio (hasta que caduque el latido) y una reserva hecha en esa
    ventana no mandaría el paquete de encendido: creería que ya está despierta. */
export async function marcarApagada(wolArmado?: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: CLAVE_HOST,
      // Se guarda como quedó la tarjeta: si no era 'g', ya sabemos por qué no despierta.
      UpdateExpression: 'SET #s = :down, lastHeartbeat = :cero, wolArmado = :wol REMOVE wakeStartedAt',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':down': 'DOWN', ':cero': 0, ':wol': wolArmado ?? null },
    }),
  )
}

/** ¿Está la máquina despierta de verdad, según el último latido?

   NO vale mirar `state` a secas: ese campo solo lo escriben el latido ('UP') y el encendido
   ('WAKING'), nadie escribe nunca 'DOWN' — la caída se deduce al leer. Así que un 'UP'
   guardado puede llevar horas siendo mentira. */
export function despiertaDeVerdad(h: Host): boolean {
  return h.state === 'UP' && Date.now() - (h.lastHeartbeat ?? 0) <= MARGEN_LATIDO_MS
}

/** Marca el slot como entregado y devuelve la dirección de conexión. */
export async function entregarSlot(index: number, port: number, hostJuego: string): Promise<string> {
  const connect = `steam://connect/${hostJuego}:${port}`
  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: clave(index),
      UpdateExpression: 'SET #e = :activo, since = :ahora, updatedAt = :ahora',
      ExpressionAttributeNames: { '#e': 'estado' },
      ExpressionAttributeValues: { ':activo': 'ACTIVO', ':ahora': Date.now() },
    }),
  )
  return connect
}

/** Intents vivos cuyo plazo ya venció. El índice solo lleva los no terminados, así que
    esta consulta es diminuta por diseño. */
export async function intentsVencidos(): Promise<Intent[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLA,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK < :ahora',
      ExpressionAttributeValues: { ':pk': 'INTENT_ACTIVO', ':ahora': `${Date.now()}` },
    }),
  )
  return (r.Items ?? []) as Intent[]
}

/** Promueve al primero de la cola: le guarda un slot y le da una ventana para entrar. */
export async function promoverPrimero(
  slotIndex: number,
  ventanaSec: number,
): Promise<EntradaCola | null> {
  const laCola = await cola()
  const primero = laCola.find((e) => e.estado === 'ESPERANDO')
  if (!primero) return null

  const deadline = Date.now() + ventanaSec * 1000

  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: { PK: 'QUEUE', SK: primero.sk },
      UpdateExpression: 'SET estado = :prom, slotIndex = :idx, claimDeadline = :dl',
      ExpressionAttributeValues: { ':prom': 'PROMOVIDO', ':idx': slotIndex, ':dl': deadline },
    }),
  )

  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: clave(slotIndex),
      UpdateExpression:
        'SET #e = :res, claimSteamId = :sid, claimDeadline = :dl, updatedAt = :ahora',
      ExpressionAttributeNames: { '#e': 'estado' },
      ExpressionAttributeValues: {
        ':res': 'RESERVADO_COLA',
        ':sid': primero.steamId,
        ':dl': deadline,
        ':ahora': Date.now(),
      },
    }),
  )

  return { ...primero, estado: 'PROMOVIDO', slotIndex, claimDeadline: deadline }
}
