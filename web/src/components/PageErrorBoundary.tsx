import { RotateCw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { ErrorScreen } from '@/components/ErrorScreen'
import { Button } from '@/components/ui/button'
import { ChunkLoadFailed } from '@/lib/chunks'
import { errorMessage } from '@/lib/errors'

interface PageErrorBoundaryProps {
  children: ReactNode
}

interface PageErrorBoundaryState {
  failure: { error: unknown } | null
}

function PageFailed({ error }: { error: unknown }) {
  const missingCode = error instanceof ChunkLoadFailed
  return (
    <ErrorScreen title={missingCode ? 'Could not load this page' : 'This page stopped working'} message={errorMessage(error)}>
      {missingCode && (
        <p className="text-sm text-muted-foreground">
          This usually happens after the app was updated while the page was open. Reloading fetches the new version.
        </p>
      )}
      <Button onClick={() => window.location.reload()}>
        <RotateCw /> Reload
      </Button>
    </ErrorScreen>
  )
}

export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { failure: null }

  static getDerivedStateFromError(error: unknown): PageErrorBoundaryState {
    return { failure: { error } }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`page: rendering ${window.location.pathname}`, error, info.componentStack)
  }

  render() {
    const { failure } = this.state
    return failure ? <PageFailed error={failure.error} /> : this.props.children
  }
}
