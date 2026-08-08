/* Usuarios.

   La identidad es el SteamID64, que llega verificado por el propio login de Steam: nadie
   puede reclamar el de otro. Por eso no hay contraseñas ni registro aparte.

   El nick y el avatar se copian de Steam en cada entrada. Son caché: si alguien se cambia
   el nombre, se actualiza la próxima vez que entre. */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ddb, TABLA } from './ddb'

export interface Usuario {
  steamId: string
  nick: string
  avatar?: string
  operador: boolean
  suspendido: boolean
  /** Candado de "una reserva por persona". */
  intentActivo?: string | null
  creadoEn: number
  ultimaEntrada: number
}

const clave = (steamId: string) => ({ PK: `USER#${steamId}`, SK: 'PROFILE' })

export async function obtener(steamId: string): Promise<Usuario | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLA, Key: clave(steamId) }))
  return (r.Item as Usuario | undefined) ?? null
}

/** Crea el usuario si es su primera vez, o refresca sus datos de Steam si ya existía.

    Se usa una sola escritura condicional en vez de leer-y-luego-escribir: dos entradas
    simultáneas (dos pestañas, un doble clic) no pueden pisarse ni duplicar el usuario.

    `operador` y `suspendido` se fijan solo al crear: son decisiones del operador tomadas
    a mano en la base de datos, y una entrada posterior no debe revertirlas. */
export async function registrarEntrada(datos: {
  steamId: string
  nick: string
  avatar?: string
}): Promise<Usuario> {
  const ahora = Date.now()

  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLA,
      Key: clave(datos.steamId),
      UpdateExpression: [
        'SET steamId = :sid',
        'nick = :nick',
        'avatar = :av',
        'ultimaEntrada = :ahora',
        'creadoEn = if_not_exists(creadoEn, :ahora)',
        'operador = if_not_exists(operador, :falso)',
        'suspendido = if_not_exists(suspendido, :falso)',
      ].join(', '),
      ExpressionAttributeValues: {
        ':sid': datos.steamId,
        ':nick': datos.nick,
        ':av': datos.avatar ?? null,
        ':ahora': ahora,
        ':falso': false,
      },
      ReturnValues: 'ALL_NEW',
    }),
  )

  return r.Attributes as Usuario
}
