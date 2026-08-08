/* Lectura de secretos con caché en memoria.

   Sin caché, el endpoint del agente pediría el parámetro a SSM cada 15 segundos para
   siempre. Cinco minutos es margen de sobra para que una rotación se propague. */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const ssm = new SSMClient({})
const cache = new Map<string, { valor: string; expira: number }>()
const TTL_MS = 5 * 60_000

export async function secreto(nombre: string): Promise<string> {
  const guardado = cache.get(nombre)
  if (guardado && guardado.expira > Date.now()) return guardado.valor

  const r = await ssm.send(new GetParameterCommand({ Name: nombre, WithDecryption: true }))
  const valor = r.Parameter?.Value
  if (!valor) throw new Error(`El parámetro ${nombre} no existe o está vacío`)

  cache.set(nombre, { valor, expira: Date.now() + TTL_MS })
  return valor
}
