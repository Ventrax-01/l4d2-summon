/* Comprueba que la petición llega a través de CloudFront.

   La Function URL está abierta (ver cdn.ts para el porqué), así que cualquiera que adivinara
   su nombre aleatorio podría llamarla. CloudFront añade una cabecera con un secreto
   compartido y aquí se exige.

   La comparación es en tiempo constante: con `===` el tiempo de respuesta delata cuántos
   bytes coinciden, lo que permite ir adivinando el secreto. */

import { timingSafeEqual } from 'node:crypto'

const ESPERADO = process.env.origenSecreto ?? ''

export function vieneDeCloudFront(cabeceras: Record<string, string | undefined>): boolean {
  if (!ESPERADO) return false

  // Las cabeceras llegan en minúscula, pero no cuesta nada ser tolerante.
  const recibido =
    cabeceras['x-origen-secreto'] ?? cabeceras['X-Origen-Secreto'] ?? ''

  const a = Buffer.from(recibido)
  const b = Buffer.from(ESPERADO)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
