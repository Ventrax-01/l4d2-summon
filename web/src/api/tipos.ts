/* La frontera de datos de la aplicación.
   Todo lo que la UI necesita del backend pasa por esta interfaz, que tiene dos
   implementaciones intercambiables: `mock` (para desarrollar y demostrar sin nube ni
   PC encendida) y `http` (contra el backend real). Ninguna pantalla habla con fetch
   directamente: así cambiar de una a otra es una variable de entorno, no un refactor. */

import type { EstadoFlota, Intent, Perfil } from '@/types'

export interface ClienteApi {
  /** GET /api/state — snapshot de la flota. Público; enriquece con `me` si hay sesión.
      Es el endpoint que alimenta casi toda la UI. */
  obtenerEstado(): Promise<EstadoFlota>

  /** POST /api/reserve — reservar, reclamar turno de cola o reintentar.
      Idempotente: si ya tengo un intent activo, devuelve ese mismo. */
  reservar(): Promise<Intent>

  /** GET /api/intent/:id — progreso del intent (para el stepper).
      Alternativa de menor payload a leer `me.intent` de obtenerEstado(). */
  obtenerIntent(id: string): Promise<Intent>

  /** POST /api/close — cierra mi servidor, cancela mi intent o me saca de la cola,
      según lo que tenga abierto. */
  cerrar(): Promise<{ ok: true; closed?: { slotIndex: number } }>

  /** POST /api/queue/join — anotarme en la cola sin intentar reservar ahora. */
  entrarACola(): Promise<{ inQueue: boolean; position: number }>

  /** POST /api/queue/leave — salir de la cola o ceder mi turno. */
  salirDeCola(): Promise<{ ok: true }>

  /** GET /api/me — perfil y límites del usuario. */
  obtenerPerfil(): Promise<Perfil>

  /** Inicia el login con Steam. En http redirige a Steam; en mock resuelve al instante. */
  entrarConSteam(): Promise<void>

  /** Cierra la sesión local. */
  salir(): Promise<void>

  /** ¿Hay sesión activa? Se resuelve en el cliente (cookie/almacenamiento). */
  haySesion(): boolean
}
