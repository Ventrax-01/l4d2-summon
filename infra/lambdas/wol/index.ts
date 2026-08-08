/* Encendido remoto de la máquina anfitriona.

   Un paquete mágico son 6 bytes 0xFF seguidos de la MAC repetida 16 veces, enviado por UDP.
   Se manda a la IP pública fija de casa; el router lo reparte a la tarjeta de red, que lo
   reconoce aunque el equipo esté apagado.

   Detalle que hace fallar esto en la práctica: al apagar, la tarjeta tarda entre 15 y 30
   segundos en quedar en modo escucha. Un paquete enviado antes se pierde sin más. Por eso
   el barrido periódico reintenta en vez de dar por hecho que el primero sirvió. */

import { createSocket } from 'node:dgram'

const MAC = process.env.wolMac!
const IP = process.env.wolIp!
const PUERTO = Number(process.env.wolPort ?? 9)

function paqueteMagico(mac: string): Buffer {
  const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex')
  if (bytes.length !== 6) throw new Error(`MAC inválida: ${mac}`)
  return Buffer.concat([Buffer.alloc(6, 0xff), Buffer.alloc(16 * 6).fill(bytes)])
}

export async function handler(): Promise<{ enviados: number }> {
  const paquete = paqueteMagico(MAC)
  const socket = createSocket('udp4')

  try {
    // Se repite unas cuantas veces: es UDP, no hay confirmación de entrega.
    const envios = 4
    for (let i = 0; i < envios; i++) {
      await new Promise<void>((resolver, rechazar) => {
        socket.send(paquete, PUERTO, IP, (err) => (err ? rechazar(err) : resolver()))
      })
    }
    console.info(JSON.stringify({ msg: 'paquete de encendido enviado', ip: IP, puerto: PUERTO, envios }))
    return { enviados: envios }
  } finally {
    socket.close()
  }
}
