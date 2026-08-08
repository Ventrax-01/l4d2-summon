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
}

export interface Host {
  state: EstadoHost
  lastHeartbeat: number
  publicIp?: string
  wakeStartedAt?: number | null
  lastWolSentAt?: number | null
  sourcebansLastUsed?: number
  sshActive?: boolean
}

export interface Slot {
  index: number
  port: number
  estado: EstadoSlot
  ownerSteamId?: string | null
  ownerNick?: string | null
  intentId?: string | null
  since?: number | null
  emptySince?: number | null
  map?: string | null
  players?: number
  bots?: number
  maxPlayers?: number
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
    return (
      (r.Item as Slot | undefined) ?? {
        // Un slot del que aún no hay item es un slot libre: no hace falta sembrarlos.
        index,
        port: PUERTO_BASE + index,
        estado: 'LIBRE' as EstadoSlot,
        updatedAt: 0,
      }
    )
  })
}

/** Reclama un slot para un intent. La condición es lo que impide que dos personas se
    lleven el mismo: si otro llegó primero, la escritura falla y hay que buscar otro. */
export async function reclamarSlot(
  index: number,
  intentId: string,
  steamId: string,
  nick: string,
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLA,
        Key: clave(index),
        UpdateExpression: [
          'SET #e = :prep, intentId = :iid, ownerSteamId = :sid, ownerNick = :nick',
          '#idx = :idx, port = :port, updatedAt = :ahora',
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

export async function liberarSlot(index: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: clave(index),
      UpdateExpression:
        'SET #e = :libre, updatedAt = :ahora REMOVE ownerSteamId, ownerNick, intentId, since, connect, claimSteamId, claimDeadline',
      ExpressionAttributeNames: { '#e': 'estado' },
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
