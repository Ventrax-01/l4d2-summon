/* Selector de implementación de la API.
   El modo sale de VITE_API_MODE, y se puede forzar el mock con ?mock=1 en la URL
   (útil para enseñar la app sin depender del backend). */

import type { ClienteApi } from './tipos'
import { clienteMock } from './mock'
import { clienteHttp } from './http'

function modoMock(): boolean {
  if (typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search)
    if (q.get('mock') === '1') return true
    if (q.get('mock') === '0') return false
  }
  return import.meta.env.VITE_API_MODE !== 'http'
}

export const esModoMock = modoMock()

export const clienteApi: ClienteApi = esModoMock ? clienteMock : clienteHttp

export type { ClienteApi }
