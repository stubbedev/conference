import { lazy, Suspense } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'

import { PageErrorBoundary } from '@/components/PageErrorBoundary'
import { loadChunk } from '@/lib/chunks'
import Home from '@/pages/Home'

const Room = lazy(() => loadChunk('the room page', () => import('@/pages/Room')))

export default function App() {
  const { pathname } = useLocation()
  return (
    <PageErrorBoundary key={pathname}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route
          path="/r/:slug"
          element={
            <Suspense>
              <Room />
            </Suspense>
          }
        />
      </Routes>
    </PageErrorBoundary>
  )
}
