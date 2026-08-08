/* Sesiones firmadas.

   Se implementa a mano en vez de traer una librería: es HMAC-SHA256 sobre dos cadenas en
   base64url, unas veinte líneas, y evita una dependencia más en el paquete de la función.

   La comparación de la firma es en tiempo constante. Con `===` el tiempo de respuesta
   depende de cuántos bytes coinciden, lo que permite adivinar una firma byte a byte. */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface Sesion {
  /** SteamID64 de quien inició sesión. Es la identidad del sistema. */
  steamId: string
  nick: string
  avatar?: string
  operador: boolean
  /** Epoch en segundos. */
  exp: number
}

const DURACION_DIAS = 30

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const desdeB64url = (s: string) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function firmar(datos: string, secreto: string): string {
  return b64url(createHmac('sha256', secreto).update(datos).digest())
}

export function emitir(datos: Omit<Sesion, 'exp'>, secreto: string): string {
  const cuerpo: Sesion = {
    ...datos,
    exp: Math.floor(Date.now() / 1000) + DURACION_DIAS * 86400,
  }
  const cabecera = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const carga = b64url(JSON.stringify(cuerpo))
  return `${cabecera}.${carga}.${firmar(`${cabecera}.${carga}`, secreto)}`
}

/** Devuelve la sesión, o null si el token es inválido, está manipulado o caducó. */
export function verificar(token: string | undefined, secreto: string): Sesion | null {
  if (!token) return null

  const partes = token.split('.')
  if (partes.length !== 3) return null
  const [cabecera, carga, firma] = partes

  const esperada = Buffer.from(firmar(`${cabecera}.${carga}`, secreto))
  const recibida = Buffer.from(firma)
  // timingSafeEqual exige la misma longitud; distinta longitud ya es inválida.
  if (esperada.length !== recibida.length) return null
  if (!timingSafeEqual(esperada, recibida)) return null

  try {
    const sesion = JSON.parse(desdeB64url(carga).toString()) as Sesion
    if (sesion.exp < Math.floor(Date.now() / 1000)) return null
    return sesion
  } catch {
    return null
  }
}

/** Cookie de sesión: httpOnly para que el JavaScript de la página no pueda leerla, así un
    XSS no se lleva la sesión. SameSite=Lax deja que funcione el retorno desde Steam. */
export function cookieSesion(token: string): string {
  const maxAge = DURACION_DIAS * 86400
  return `l4d2_sesion=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

export function cookieBorrado(): string {
  return 'l4d2_sesion=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
}

/** Extrae la cookie de sesión de la cabecera Cookie. */
export function sesionDeCookies(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined
  for (const trozo of cookie.split(';')) {
    const [k, ...v] = trozo.trim().split('=')
    if (k === 'l4d2_sesion') return v.join('=')
  }
  return undefined
}
