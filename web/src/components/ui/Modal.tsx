/* Modal de confirmación. Se usa para acciones que afectan a otros —cerrar un servidor
   desconecta a quien esté dentro—, así que el texto dice el impacto real. */

import { useEffect, useRef } from 'react'
import './Modal.css'

interface Props {
  titulo: string
  children: React.ReactNode
  textoConfirmar: string
  textoCancelar: string
  onConfirmar: () => void
  onCancelar: () => void
}

export default function Modal({
  titulo,
  children,
  textoConfirmar,
  textoCancelar,
  onConfirmar,
  onCancelar,
}: Props) {
  const caja = useRef<HTMLDivElement>(null)

  // Foco al abrir y cierre con Escape: es un diálogo, debe comportarse como tal.
  useEffect(() => {
    caja.current?.focus()
    const alTecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelar()
    }
    document.addEventListener('keydown', alTecla)
    return () => document.removeEventListener('keydown', alTecla)
  }, [onCancelar])

  return (
    <div className="mod-fondo" onClick={onCancelar}>
      <div
        className="mod"
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        tabIndex={-1}
        ref={caja}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{titulo}</h2>
        <div className="mod-cuerpo">{children}</div>
        <button className="mod-confirmar" onClick={onConfirmar}>
          {textoConfirmar}
        </button>
        <button className="mod-cancelar" onClick={onCancelar}>
          {textoCancelar}
        </button>
      </div>
    </div>
  )
}
