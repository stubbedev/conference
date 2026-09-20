import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { Toaster } from '@/components/ui/sonner'
import './index.css'

// No StrictMode: double-invoked effects would connect media twice.
createRoot(document.getElementById('root')!).render(
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
    <BrowserRouter>
      <App />
      <Toaster richColors position="bottom-right" />
    </BrowserRouter>
  </ThemeProvider>,
)
