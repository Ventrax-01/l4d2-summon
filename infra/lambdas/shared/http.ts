/* Respuestas HTTP con forma consistente.

   El backend NO devuelve 403 ni 404: CloudFront los convierte en index.html para que
   funcione el enrutado de la SPA, así que un error real con esos códigos llegaría al
   navegador como una página HTML con estado 200. Se usan 401, 409 y 422 en su lugar.
   Ver docs/tecnico/02-estados-api.md. */

export type Codigo =
  | 'UNAUTHORIZED' | 'SUSPENDED' | 'RESERVAS_DISABLED' | 'COOLDOWN'
  | 'WAKE_LIMIT' | 'NOT_FOUND' | 'CONFLICTO' | 'VALIDACION' | 'UNKNOWN'

const ESTADO: Record<Codigo, number> = {
  UNAUTHORIZED: 401,
  SUSPENDED: 401,
  RESERVAS_DISABLED: 409,
  COOLDOWN: 429,
  WAKE_LIMIT: 429,
  NOT_FOUND: 410,   // NO 404: CloudFront lo reescribiría
  CONFLICTO: 409,
  VALIDACION: 422,
  UNKNOWN: 500,
}

const CABECERAS = { 'content-type': 'application/json; charset=utf-8' }

export function ok(cuerpo: unknown, extra: Record<string, string> = {}) {
  return { statusCode: 200, headers: { ...CABECERAS, ...extra }, body: JSON.stringify(cuerpo) }
}

export function error(codigo: Codigo, mensaje: string) {
  return {
    statusCode: ESTADO[codigo],
    headers: CABECERAS,
    body: JSON.stringify({ codigo, mensaje }),
  }
}

export function redirigir(destino: string, extra: Record<string, string> = {}) {
  return { statusCode: 302, headers: { location: destino, ...extra }, body: '' }
}
