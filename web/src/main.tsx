import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ProveedorFlota } from '@/context/FlotaContext'
import App from './App'
import '@/styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ProveedorFlota>
        <App />
      </ProveedorFlota>
    </BrowserRouter>
  </StrictMode>,
)
