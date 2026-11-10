import { Toaster as Sonner, type ToasterProps } from 'sonner'

import { useTheme } from '@/lib/theme'
import { colorScheme } from '@/lib/themes'

function Toaster(props: ToasterProps) {
  const { theme } = useTheme()
  return <Sonner theme={colorScheme(theme)} className="toaster group" {...props} />
}

export { Toaster }
