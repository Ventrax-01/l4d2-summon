/* Botón base. Variantes tomadas del Board: primario (cian con glow), contorno,
   fantasma y peligro. */

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './Boton.css'

type Variante = 'primario' | 'contorno' | 'fantasma' | 'peligro'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: Variante
  /** Ocupa todo el ancho disponible: por defecto en móvil. */
  ancho?: boolean
  cargando?: boolean
  children: ReactNode
}

export default function Boton({
  variante = 'primario',
  ancho = false,
  cargando = false,
  disabled,
  children,
  className = '',
  ...resto
}: Props) {
  return (
    <button
      className={`btn btn--${variante} ${ancho ? 'btn--ancho' : ''} ${className}`}
      disabled={disabled || cargando}
      aria-busy={cargando || undefined}
      {...resto}
    >
      {cargando && <span className="btn-spin" aria-hidden="true" />}
      {children}
    </button>
  )
}
