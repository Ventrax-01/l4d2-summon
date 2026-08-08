/* Datos semilla del modo mock.

   Deliberadamente hostiles al layout: nicks largos, campañas de nombre largo y partidas
   llenas. Si la UI aguanta esto, aguanta lo real. */

export interface Campania {
  /** Código del mapa tal como lo reporta el servidor. */
  map: string
  /** Nombre de la campaña. Se mantiene en inglés: es como se conoce el juego. */
  nombre: string
  /** Color base del degradado de la miniatura: uno por campaña. */
  grad: string
}

export const CAMPANIAS: Campania[] = [
  { map: 'c1m1_hotel', nombre: 'Dead Center', grad: '#233041' },
  { map: 'c2m1_highway', nombre: 'Dark Carnival', grad: '#2E2A3C' },
  { map: 'c3m1_plankcountry', nombre: 'Swamp Fever', grad: '#2A3626' },
  { map: 'c4m1_milltown_a', nombre: 'Hard Rain', grad: '#22343A' },
  { map: 'c5m1_waterfront', nombre: 'The Parish', grad: '#3C3226' },
  { map: 'c6m1_riverbank', nombre: 'The Passing', grad: '#33262E' },
  { map: 'c13m1_alpinecreek', nombre: 'Cold Stream', grad: '#26303C' },
  { map: 'c8m1_apartment', nombre: 'No Mercy', grad: '#243038' },
  { map: 'c11m4_terminal', nombre: 'Dead Air', grad: '#2A2E36' },
  { map: 'c12m5_cornfield', nombre: 'Blood Harvest', grad: '#2E3326' },
  { map: 'c9m1_alleys', nombre: 'Crash Course', grad: '#2C2A30' },
  { map: 'c10m4_mainstreet', nombre: 'Death Toll', grad: '#2A2C34' },
  { map: 'c7m1_docks', nombre: 'The Sacrifice', grad: '#26313A' },
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
// Un data: URI en vez de una URL de Steam inventada: aquella daba 404 y el mock
// mostraba el icono de imagen rota en vez de un avatar.
export const MI_AVATAR =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='%232e4a5c'/><circle cx='32' cy='25' r='12' fill='%238fd4ec'/><ellipse cx='32' cy='58' rx='20' ry='16' fill='%238fd4ec'/></svg>"

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
