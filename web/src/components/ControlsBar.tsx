import { Link2, Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Video, VideoOff } from 'lucide-react'

import { Button } from '@/components/ui/button'

interface ControlsBarProps {
  mic: boolean
  cam: boolean
  sharing: boolean
  onMic: () => void
  onCam: () => void
  onShare: () => void
  onInvite: () => void
  onLeave: () => void
}

export function ControlsBar({
  mic,
  cam,
  sharing,
  onMic,
  onCam,
  onShare,
  onInvite,
  onLeave,
}: ControlsBarProps) {
  return (
    <div className="flex items-center justify-center gap-2 border-t px-4 py-3">
      <Button
        variant={mic ? 'secondary' : 'destructive'}
        size="icon"
        onClick={onMic}
        title={mic ? 'Mute microphone' : 'Unmute microphone'}
      >
        {mic ? <Mic /> : <MicOff />}
      </Button>
      <Button
        variant={cam ? 'secondary' : 'destructive'}
        size="icon"
        onClick={onCam}
        title={cam ? 'Turn camera off' : 'Turn camera on'}
      >
        {cam ? <Video /> : <VideoOff />}
      </Button>
      <Button
        variant={sharing ? 'destructive' : 'secondary'}
        size="icon"
        onClick={onShare}
        title={sharing ? 'Stop sharing' : 'Share your screen'}
      >
        {sharing ? <MonitorX /> : <MonitorUp />}
      </Button>
      <Button variant="ghost" size="icon" onClick={onInvite} title="Copy invite link">
        <Link2 />
      </Button>
      <Button variant="destructive" onClick={onLeave}>
        <PhoneOff /> Leave
      </Button>
    </div>
  )
}
