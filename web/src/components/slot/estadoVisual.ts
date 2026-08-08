/* Traducción de estado de slot a su presentación.

   Regla del Board: un estado nunca se comunica solo con color — siempre color + icono +
   etiqueta. Por eso cada descriptor lleva las tres cosas. */

import type { EstadoSlot } from '@/types'

export interface Visual {
  /** Etiqueta del chip. `null` = el estado no lleva chip (ACTIVO lo indica en la imagen). */
  etiqueta: string | null
  icono: string
  /** Nombre de la variable CSS del color, sin el `var()`. */
  color: string
  /** Texto para lectores de pantalla, por si el chip se percibe solo visualmente. */
  descripcion: string
}

const VISUALES: Record<EstadoSlot, Visual> = {
  LIBRE: {
    etiqueta: 'LIBRE',
    icono: '●',
    color: '--free',
    descripcion: 'Servidor libre, disponible para reservar',
  },
  PREPARANDO: {
    etiqueta: 'PREPARANDO',
    icono: '●',
    color: '--prep',
    descripcion: 'Servidor preparándose',
  },
  ACTIVO: {
    etiqueta: 'EN JUEGO',
    icono: '●',
    color: '--accent',
    descripcion: 'Servidor en juego',
  },
  VACIO: {
    etiqueta: 'SIN GENTE',
    icono: '○',
    color: '--text-muted',
    descripcion: 'Servidor abierto pero vacío; se cerrará solo',
  },
  RESERVADO_COLA: {
    etiqueta: 'RESERVADO',
    icono: '⧗',
    color: '--reserved',
    descripcion: 'Servidor reservado para el siguiente de la cola',
  },
  CERRANDO: {
    etiqueta: 'CERRANDO',
    icono: '◌',
    color: '--text-muted',
    descripcion: 'Servidor cerrándose',
  },
  ERROR: {
    etiqueta: 'ERROR',
    icono: '⚠',
    color: '--danger',
    descripcion: 'El servidor no pudo prepararse',
  },
}

export function visualDe(estado: EstadoSlot): Visual {
  return VISUALES[estado]
}
