/* Datos semilla del modo mock.

   Deliberadamente hostiles al layout: nicks largos, campañas de nombre largo y partidas
   llenas. Si la UI aguanta esto, aguanta lo real. */

export interface Campania {
  /** Código del mapa tal como lo reporta el servidor. */
  map: string
  /** Nombre para mostrar. */
  nombre: string
  /** Color base del degradado de la miniatura: uno por campaña. */
  grad: string
}

export const CAMPANIAS: Campania[] = [
  { map: 'c1m1_hotel', nombre: 'Centro Mortal', grad: '#233041' },
  { map: 'c2m1_highway', nombre: 'Feria Oscura', grad: '#2E2A3C' },
  { map: 'c3m1_plankcountry', nombre: 'Fiebre del Pantano', grad: '#2A3626' },
  { map: 'c4m1_milltown_a', nombre: 'Lluvia Torrencial', grad: '#22343A' },
  { map: 'c5m1_waterfront', nombre: 'La Parroquia', grad: '#3C3226' },
  { map: 'c6m1_riverbank', nombre: 'El Sacrificio', grad: '#33262E' },
  { map: 'c13m1_alpinecreek', nombre: 'Arroyo Helado', grad: '#26303C' },
]

/** Nicks de Steam realistas, incluyendo algunos deliberadamente largos. */
export const NICKS = [
  'R4zor',
  'ElPatoConBotas_2007',
  'zeta',
  'Mariana//sniper',
  'xX_DarkShadowHunter_Xx',
  'Kuma',
  'seba.exe',
  'LaChampionsLiga',
]

export const MI_STEAM_ID = '76561198012348231'
export const MI_NICK = 'R4zor'
export const MI_AVATAR = 'https://avatars.steamstatic.com/placeholder_full.jpg'

/** Host al que se conectan los jugadores. Los servidores de juego NO van por CloudFront:
    tienen su propio registro A hacia la IP fija de casa. */
export const HOST_JUEGO = 'play.ventrax.dev'
export const PUERTO_BASE = 6032

export function puertoDe(index: number): number {
  return PUERTO_BASE + index
}

export function connectDe(index: number): string {
  return `steam://connect/${HOST_JUEGO}:${puertoDe(index)}`
}

/** Elige un elemento de forma estable a partir de un índice (sin aleatoriedad, para que
    recargar no cambie la escena). */
export function estable<T>(lista: T[], semilla: number): T {
  return lista[semilla % lista.length]
}

/** Color del degradado de la miniatura para un mapa. */
export function gradienteDeMapa(map?: string): string {
  return CAMPANIAS.find((c) => c.map === map)?.grad ?? '#233041'
}
