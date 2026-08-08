/* Utilidades de presentación compartidas. */

import { CAMPANIAS, gradienteDeMapa } from '@/api/mock/datos'

/** "hace 24 min" / "hace 3 h". Entrada en epoch-ms. */
export function desdeHace(epoch?: number): string {
  if (!epoch) return ''
  const min = Math.max(0, Math.floor((Date.now() - epoch) / 60_000))
  if (min < 1) return 'recién'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}

/** Nombre legible de la campaña a partir del código de mapa que reporta el servidor.
    Si es un mapa desconocido (personalizado), se muestra el código tal cual. */
export function nombreDeMapa(map?: string): string {
  if (!map) return ''
  return CAMPANIAS.find((c) => c.map === map)?.nombre ?? map
}

/** Iniciales para el avatar de texto. */
export function iniciales(nick?: string): string {
  if (!nick) return '??'
  const limpio = nick.replace(/[^\p{L}\p{N}]/gu, '')
  return (limpio.slice(0, 2) || '??').toUpperCase()
}

/** Convierte "steam://connect/host:puerto" en "connect host:puerto" para copiar
    en la consola del juego. */
export function comandoConnect(url?: string | null): string {
  if (!url) return ''
  return `connect ${url.replace('steam://connect/', '')}`
}

/** Degradado de la miniatura del mapa (uno por campaña, como en el diseño). */
export function gradienteMapa(map?: string): string {
  return gradienteDeMapa(map)
}
