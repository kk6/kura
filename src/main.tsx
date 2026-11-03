import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import App from './App.tsx'

if (import.meta.env.MODE === 'mock') {
  const { installMockIPC } = await import('./mocks/ipc.ts')
  installMockIPC()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
