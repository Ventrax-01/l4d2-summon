/* Endpoint del agente de la máquina anfitriona: heartbeat, estado y cola de órdenes.

   PENDIENTE DE IMPLEMENTAR. El contrato está definido en
   docs/tecnico/02-estados-api.md; este esqueleto existe para que la infraestructura sea
   desplegable y verificable de punta a punta antes de escribir la lógica.

   Responde 501 a propósito: es explícito y no simula un funcionamiento que no existe. */

import { error } from '../shared/http'
import { vieneDeCloudFront } from '../shared/origen'

interface Evento {
  headers?: Record<string, string | undefined>
}

export async function handler(evento: Evento) {
  // Primero: solo se atienden peticiones que vengan por CloudFront.
  if (!vieneDeCloudFront(evento.headers ?? {})) {
    return error('UNAUTHORIZED', 'Acceso no autorizado.')
  }

  return error('UNKNOWN', 'Este endpoint todavía no está implementado.')
}
