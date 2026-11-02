import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'

import Home from '@/pages/Home'

const Room = lazy(() => import('@/pages/Room'))

export default function App() {
  return (
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
  )
}
