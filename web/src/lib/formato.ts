/* Utilidades de presentación compartidas. */

import { gradienteDeMapa } from '@/api/mock/datos'
import { campaniaDe } from './mapas'

/** "hace 24 min" / "hace 3 h". Entrada en epoch-ms. */
export function desdeHace(epoch?: number): string {
  if (!epoch) return ''
  const min = Math.max(0, Math.floor((Date.now() - epoch) / 60_000))
  if (min < 1) return 'recién'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}

/** Campaña a la que pertenece el mapa. Si es uno de la comunidad, se muestra su código. */
export function nombreDeMapa(map?: string): string {
  if (!map) return ''
  return campaniaDe(map) || map
}

/** Iniciales para el avatar de texto. */
export function iniciales(nick?: string): string {
  if (!nick) return '??'
  const limpio = nick.replace(/[^\p{L}\p{N}]/gu, '')
  return (limpio.slice(0, 2) || '??').toUpperCase()
}

/** Convierte "steam://connect/host:puerto" en "connect host:puerto" para copiar
    en la consola del juego. */
/** Lo que se escribe en la consola del juego. Se arma con la dirección en crudo que da la
    API y no recortando el enlace de Steam: ese enlace cambió de forma una vez y se llevó
    esto por delante en silencio. */
export function comandoConnect(direccion?: string | null): string {
  return direccion ? `connect ${direccion}` : ''
}

/** Degradado de la miniatura del mapa (uno por campaña, como en el diseño). */
export function gradienteMapa(map?: string): string {
  return gradienteDeMapa(map)
}

/** Miniatura del mapa. Son las imágenes oficiales que el juego usa en su selector,
    servidas desde nuestro propio CDN (no se enlazan desde fuera). */
export function imagenDeMapa(map?: string): string | null {
  return map ? `/mapas/${map}.webp` : null
}
