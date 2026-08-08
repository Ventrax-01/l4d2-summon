/* Implementación real contra el backend.
   Todo cuelga del mismo origen (CloudFront enruta /api/* y /auth/steam* a las Lambdas),
   así que no hay CORS ni base absoluta que configurar en producción.

   El backend aún no existe: esta implementación está escrita contra el contrato de
   docs/tecnico/02-estados-api.md y se activa con VITE_API_MODE=http cuando haya nube. */

import type { ClienteApi } from './tipos'
import type { EstadoFlota, Intent, Perfil, CodigoError } from '@/types'
import { ErrorApi } from '@/types'

const BASE = import.meta.env.VITE_API_BASE ?? '/api'

/** El backend responde errores con { codigo, mensaje }; cualquier otra cosa se
    normaliza para que la UI nunca tenga que adivinar. */
async function pedir<T>(ruta: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${ruta}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    // Sin red o el servicio no responde en absoluto.
    throw new ErrorApi('BACKEND_DOWN', 'No pudimos conectar con el servicio.')
  }

  if (!res.ok) {
    let codigo: CodigoError = 'UNKNOWN'
    let mensaje = 'Algo salió mal.'
    try {
      const body = await res.json()
      if (body?.codigo) codigo = body.codigo
      if (body?.mensaje) mensaje = body.mensaje
    } catch {
      /* respuesta sin JSON: nos quedamos con los valores por defecto */
    }
    if (res.status === 401) codigo = 'UNAUTHORIZED'
    if (res.status === 404 && codigo === 'UNKNOWN') codigo = 'NOT_FOUND'
    throw new ErrorApi(codigo, mensaje, res.status)
  }

  return res.json() as Promise<T>
}

export const clienteHttp: ClienteApi = {
  obtenerEstado: () => pedir<EstadoFlota>('/state'),
  reservar: () => pedir<Intent>('/reserve', { method: 'POST' }),
  obtenerIntent: (id) => pedir<Intent>(`/intent/${encodeURIComponent(id)}`),
  cerrar: () => pedir('/close', { method: 'POST' }),
  entrarACola: () => pedir('/queue/join', { method: 'POST' }),
  salirDeCola: () => pedir('/queue/leave', { method: 'POST' }),
  obtenerPerfil: () => pedir<Perfil>('/me'),

  async entrarConSteam() {
    // El login es una redirección del navegador, no una llamada de datos:
    // la Lambda de /auth/steam/login lleva a Steam y Steam vuelve a /auth/steam/return.
    window.location.href = '/auth/steam/login'
  },

  async salir() {
    await pedir('/logout', { method: 'POST' }).catch(() => undefined)
  },

  haySesion() {
    // La sesión vive en una cookie httpOnly, que el JS no puede leer: la verdad la da
    // el propio /api/state (trae `me` solo si hay sesión válida).
    return document.cookie.includes('l4d2_session_hint=1')
  },
}
