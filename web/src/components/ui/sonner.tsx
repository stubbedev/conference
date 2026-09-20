import { useTheme } from 'next-themes'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster(props: ToasterProps) {
  const { theme } = useTheme()
  return <Sonner theme={theme as ToasterProps['theme']} className="toaster group" {...props} />
}

export { Toaster }
