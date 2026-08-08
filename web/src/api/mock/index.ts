/* Implementación mock de la API, montada sobre el motor de simulación.

   Con esto la aplicación funciona entera sin backend: se puede recorrer la reserva
   completa, la cola, los errores y el servicio caído. Se activa con VITE_API_MODE=mock
   (por defecto) o con ?mock=1 en la URL. */

import type { ClienteApi } from '../tipos'
import type { EstadoFlota, Intent, Perfil } from '@/types'
import { ErrorApi } from '@/types'
import { obtenerEscenario } from './escenarios'
import { MI_AVATAR, MI_NICK, MI_STEAM_ID } from './datos'
import * as motor from './motor'

/** Latencia simulada: sin ella los estados de carga nunca se ven en desarrollo. */
function demora(min = 120, max = 380): Promise<void> {
  const ms = min + Math.random() * (max - min)
  return new Promise((r) => setTimeout(r, ms))
}

/** Los escenarios de fallo se comprueban antes de cada llamada. */
function comprobarCaidas(esLista = false): void {
  const e = obtenerEscenario()
  if (e.backendCaido) {
    throw new ErrorApi('BACKEND_DOWN', 'No pudimos conectar con el servicio.')
  }
  if (esLista && e.errorDeLista) {
    throw new ErrorApi('UNKNOWN', 'No pudimos cargar la lista de servidores.')
  }
}

export const clienteMock: ClienteApi = {
  async obtenerEstado(): Promise<EstadoFlota> {
    await demora(80, 220)
    comprobarCaidas(true)
    return motor.leerEstado()
  },

  async reservar(): Promise<Intent> {
    await demora()
    comprobarCaidas()
    return motor.reservar()
  },

  async obtenerIntent(id: string): Promise<Intent> {
    await demora(60, 140)
    comprobarCaidas()
    const it = motor.intentActual()
    if (!it || it.id !== id) throw new ErrorApi('NOT_FOUND', 'Ese intento ya no existe.')
    return it
  },

  async cerrar() {
    await demora()
    comprobarCaidas()
    return motor.cerrar()
  },

  async entrarACola() {
    await demora()
    comprobarCaidas()
    return motor.entrarACola()
  },

  async salirDeCola() {
    await demora()
    comprobarCaidas()
    motor.salirDeCola()
    return { ok: true as const }
  },

  async obtenerPerfil(): Promise<Perfil> {
    await demora()
    comprobarCaidas()
    if (!motor.haySesion()) throw new ErrorApi('UNAUTHORIZED', 'Necesitas iniciar sesión.')

    const estado = motor.leerEstado()
    return {
      steamId: MI_STEAM_ID,
      nick: MI_NICK,
      avatar: MI_AVATAR,
      operador: false,
      suspendido: false,
      intent: estado.me?.intent ?? null,
      queue: {
        inQueue: estado.me?.queue.inQueue ?? false,
        position: estado.me?.queue.position ?? null,
      },
      slot: estado.me?.slot
        ? { index: estado.me.slot.index, connect: estado.me.slot.connect }
        : null,
      limits: { wakesToday: 2, maxWakesPerDay: 20, cooldownRemainingSec: 0 },
    }
  },

  async entrarConSteam(): Promise<void> {
    await demora(400, 900) // el redirect real a Steam también tarda
    if (obtenerEscenario().loginFalla) {
      throw new ErrorApi('UNKNOWN', 'No pudimos iniciar sesión con Steam.')
    }
    motor.iniciarSesion()
  },

  async salir(): Promise<void> {
    await demora(80, 150)
    motor.cerrarSesion()
  },

  haySesion(): boolean {
    return motor.haySesion()
  },
}
