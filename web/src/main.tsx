import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { Toaster } from '@/components/ui/sonner'
import './index.css'

// No StrictMode: double-invoked effects would connect media twice.
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
    <Toaster richColors position="bottom-right" />
  </BrowserRouter>,
)
