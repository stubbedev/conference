import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { Toaster } from '@/components/ui/sonner'
import { purgePlaintextRoomPasswords } from '@/lib/roompass'
import { THEMES } from '@/lib/themes'
// Cyberchat 2077's fonts, bundled rather than fetched from a font CDN, so
// the app makes no third-party requests.
import '@fontsource/chakra-petch/400.css'
import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource/chakra-petch/700.css'
import '@fontsource/orbitron/500.css'
import '@fontsource/orbitron/700.css'
import './index.css'

purgePlaintextRoomPasswords()

// No StrictMode: double-invoked effects would connect media twice.
createRoot(document.getElementById('root')!).render(
  <ThemeProvider attribute="class" themes={[...THEMES]} defaultTheme="dark" enableSystem disableTransitionOnChange>
    <BrowserRouter>
      <App />
      <Toaster richColors position="bottom-right" />
    </BrowserRouter>
  </ThemeProvider>,
)
