import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster(props: ToasterProps) {
  return <Sonner theme="dark" className="toaster group" {...props} />
}

export { Toaster }
