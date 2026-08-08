/* Mapas oficiales de Left 4 Dead 2: código → capítulo y campaña.

   El servidor reporta el código (`c1m1_hotel`); la interfaz muestra el nombre. Los nombres
   se mantienen en inglés, que es como se conocen.

   Un mapa que no esté aquí (uno de la comunidad) se muestra con su propio código, así que la
   lista no necesita estar completa para que la interfaz funcione. */

export interface Mapa {
  capitulo: string
  campania: string
}

export const MAPAS: Record<string, Mapa> = {
  // Dead Center
  c1m1_hotel: { capitulo: 'The Hotel', campania: 'Dead Center' },
  c1m2_streets: { capitulo: 'The Streets', campania: 'Dead Center' },
  c1m3_mall: { capitulo: 'The Mall', campania: 'Dead Center' },
  c1m4_atrium: { capitulo: 'The Atrium', campania: 'Dead Center' },

  // Dark Carnival
  c2m1_highway: { capitulo: 'The Highway', campania: 'Dark Carnival' },
  c2m2_fairgrounds: { capitulo: 'The Fairgrounds', campania: 'Dark Carnival' },
  c2m3_coaster: { capitulo: 'The Coaster', campania: 'Dark Carnival' },
  c2m4_barns: { capitulo: 'The Barns', campania: 'Dark Carnival' },
  c2m5_concert: { capitulo: 'The Concert', campania: 'Dark Carnival' },

  // Swamp Fever
  c3m1_plankcountry: { capitulo: 'Plank Country', campania: 'Swamp Fever' },
  c3m2_swamp: { capitulo: 'The Swamp', campania: 'Swamp Fever' },
  c3m3_shantytown: { capitulo: 'Shanty Town', campania: 'Swamp Fever' },
  c3m4_plantation: { capitulo: 'The Plantation', campania: 'Swamp Fever' },

  // Hard Rain
  c4m1_milltown_a: { capitulo: 'The Milltown', campania: 'Hard Rain' },
  c4m2_sugarmill_a: { capitulo: 'The Sugar Mill', campania: 'Hard Rain' },
  c4m3_sugarmill_b: { capitulo: 'Mill Escape', campania: 'Hard Rain' },
  c4m4_milltown_b: { capitulo: 'Return to Town', campania: 'Hard Rain' },
  c4m5_milltown_escape: { capitulo: 'Town Escape', campania: 'Hard Rain' },

  // The Parish
  c5m1_waterfront: { capitulo: 'The Waterfront', campania: 'The Parish' },
  c5m2_park: { capitulo: 'The Park', campania: 'The Parish' },
  c5m3_cemetery: { capitulo: 'The Cemetery', campania: 'The Parish' },
  c5m4_quarter: { capitulo: 'The Quarter', campania: 'The Parish' },
  c5m5_bridge: { capitulo: 'The Bridge (The Parish)', campania: 'The Parish' },

  // The Passing
  c6m1_riverbank: { capitulo: 'The Riverbank', campania: 'The Passing' },
  c6m2_bedlam: { capitulo: 'The Underground', campania: 'The Passing' },
  c6m3_port: { capitulo: 'The Port', campania: 'The Passing' },

  // The Sacrifice
  c7m1_docks: { capitulo: 'The Docks', campania: 'The Sacrifice' },
  c7m2_barge: { capitulo: 'The Barge', campania: 'The Sacrifice' },
  c7m3_port: { capitulo: 'The Port (The Sacrifice)', campania: 'The Sacrifice' },

  // No Mercy
  c8m1_apartment: { capitulo: 'The Apartments', campania: 'No Mercy' },
  c8m2_subway: { capitulo: 'The Subway', campania: 'No Mercy' },
  c8m3_sewers: { capitulo: 'The Sewer', campania: 'No Mercy' },
  c8m4_interior: { capitulo: 'The Hospital', campania: 'No Mercy' },
  c8m5_rooftop: { capitulo: 'Rooftop Finale', campania: 'No Mercy' },

  // Crash Course
  c9m1_alleys: { capitulo: 'The Alleys', campania: 'Crash Course' },
  c9m2_lots: { capitulo: 'The Truck Depot Finale', campania: 'Crash Course' },

  // Death Toll
  c10m1_caves: { capitulo: 'The Turnpike', campania: 'Death Toll' },
  c10m2_drainage: { capitulo: 'The Drains', campania: 'Death Toll' },
  c10m3_ranchhouse: { capitulo: 'The Church', campania: 'Death Toll' },
  c10m4_mainstreet: { capitulo: 'The Town', campania: 'Death Toll' },
  c10m5_houseboat: { capitulo: 'Boathouse Finale', campania: 'Death Toll' },

  // Dead Air
  c11m1_greenhouse: { capitulo: 'The Greenhouse', campania: 'Dead Air' },
  c11m2_offices: { capitulo: 'The Crane', campania: 'Dead Air' },
  c11m3_garage: { capitulo: 'The Construction Site', campania: 'Dead Air' },
  c11m4_terminal: { capitulo: 'The Terminal', campania: 'Dead Air' },
  c11m5_runway: { capitulo: 'Runway Finale', campania: 'Dead Air' },

  // Blood Harvest
  c12m1_hilltop: { capitulo: 'The Woods', campania: 'Blood Harvest' },
  c12m2_traintunnel: { capitulo: 'The Tunnel', campania: 'Blood Harvest' },
  c12m3_bridge: { capitulo: 'The Bridge (Blood Harvest)', campania: 'Blood Harvest' },
  c12m4_barn: { capitulo: 'The Train Station', campania: 'Blood Harvest' },
  c12m5_cornfield: { capitulo: 'Farmhouse Finale', campania: 'Blood Harvest' },

  // Cold Stream
  c13m1_alpinecreek: { capitulo: 'Alpine Creek', campania: 'Cold Stream' },
  c13m2_southpinestream: { capitulo: 'South Pine Stream', campania: 'Cold Stream' },
  c13m3_memorialbridge: { capitulo: 'Memorial Bridge', campania: 'Cold Stream' },
  c13m4_cutthroatcreek: { capitulo: 'Cut-throat Creek', campania: 'Cold Stream' },

  // The Last Stand
  c14m1_junkyard: { capitulo: 'The Junkyard', campania: 'The Last Stand' },
  c14m2_lighthouse: { capitulo: 'The Lighthouse', campania: 'The Last Stand' },
}

/** Nombre del capítulo, o el propio código si es un mapa desconocido. */
export function capituloDe(map?: string): string {
  if (!map) return ''
  return MAPAS[map]?.capitulo ?? map
}

/** Nombre de la campaña, vacío si el mapa no es oficial. */
export function campaniaDe(map?: string): string {
  if (!map) return ''
  return MAPAS[map]?.campania ?? ''
}
