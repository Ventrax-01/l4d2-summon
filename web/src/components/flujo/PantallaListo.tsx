/* Entrega del servidor: el momento de éxito del producto.

   Da tres cosas en orden de importancia: el botón para conectar, la dirección copiable
   para quien prefiera la consola o quiera compartirla, y la chuleta de lo que puede hacer
   como admin — incluyendo lo que NO puede, que es tan importante como lo que sí. */

import { useState } from 'react'
import { comandoConnect } from '@/lib/formato'
import './PantallaListo.css'

interface Props {
  connectUrl: string
  slotIndex: number | null
  onIrAMiServidor: () => void
  onCerrar: () => void
}

export default function PantallaListo({
  connectUrl,
  slotIndex,
  onIrAMiServidor,
  onCerrar,
}: Props) {
  const [copiado, setCopiado] = useState(false)
  const comando = comandoConnect(connectUrl)

  async function copiar() {
    try {
      await navigator.clipboard.writeText(comando)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1800)
    } catch {
      // Sin permiso de portapapeles (o sin HTTPS): el usuario siempre puede
      // seleccionar el texto a mano, así que no interrumpimos con un error.
    }
  }

  return (
    <main className="listo">
      <header className="listo-hero">
        <span className="listo-check" aria-hidden="true">
          ✓
        </span>
        <h1>¡Tu servidor está listo!</h1>
        <p>
          El servidor {slotIndex != null ? `#${slotIndex}` : ''} está arriba y es tuyo. A jugar.
        </p>
      </header>

      <a className="listo-conectar" href={connectUrl}>
        <span aria-hidden="true">▶</span> Conectar
      </a>

      <section className="listo-manual">
        <h2 className="listo-rotulo">O CONECTA MANUALMENTE</h2>
        <div className="listo-dir">
          <code>{comando}</code>
          <button onClick={() => void copiar()} title="Copiar dirección" aria-label="Copiar dirección">
            {copiado ? '✓' : '⧉'}
          </button>
        </div>
        <p className="listo-pista">
          Compártela: cualquiera puede entrar, el servidor es público.
        </p>
        <span className="solo-lectores" role="status">
          {copiado ? 'Dirección copiada' : ''}
        </span>
      </section>

      <section className="listo-admin">
        <h2>
          <span aria-hidden="true">🛡</span> ERES ADMIN DE ESTE SERVIDOR
        </h2>
        <ul>
          <li>
            <span className="listo-si" aria-hidden="true">
              ✓
            </span>
            Expulsar jugadores (kick)
          </li>
          <li>
            <span className="listo-si" aria-hidden="true">
              ✓
            </span>
            Cambiar de mapa
          </li>
          <li>
            <span className="listo-si" aria-hidden="true">
              ✓
            </span>
            Controlar la partida (reiniciar, pausar…)
          </li>
          <li className="listo-no">
            <span aria-hidden="true">✕</span>
            Banear — eso no está en tus manos
          </li>
        </ul>
      </section>

      <aside className="listo-nota">
        <span aria-hidden="true">🌙</span>
        <p>Tu servidor se cierra solo si queda vacío un rato. No tienes que hacer nada.</p>
      </aside>

      <div className="listo-acciones">
        <button className="listo-sec" onClick={onIrAMiServidor}>
          Ir a Mi servidor
        </button>
        <button className="listo-cerrar" onClick={onCerrar}>
          Cerrar servidor
        </button>
      </div>
    </main>
  )
}
