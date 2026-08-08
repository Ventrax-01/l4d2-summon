/* API pública que consume el navegador: estado de la flota, reservar, cola y cerrar.

   PENDIENTE DE IMPLEMENTAR. El contrato está definido en
   docs/tecnico/02-estados-api.md; este esqueleto existe para que la infraestructura sea
   desplegable y verificable de punta a punta antes de escribir la lógica.

   Responde 501 a propósito: es explícito y no simula un funcionamiento que no existe. */

import { error } from '../shared/http'

export async function handler() {
  return error('UNKNOWN', 'Este endpoint todavía no está implementado.')
}
