import type { CSSProperties, ReactNode } from 'react'
import { Settings2 } from 'lucide-react'

import {
  CAMERA_RESOLUTIONS,
  cameraDisplayName,
  DEVICE_LABELS,
  isMobileDevice,
  MAX_MIC_GAIN_DB,
  micDbToGain,
  micGainToDb,
  MIN_MIC_GAIN_DB,
  selectedCameraId,
  type CameraResolution,
  type DeviceGroups,
  type DeviceKind,
  type DevicePrefs,
} from '@/hooks/media'
import { askForSpeaker, audioOutputs } from '@/hooks/audio-output'
import { Button } from '@/components/ui/button'
import { Disclosure } from '@/components/Disclosure'
import { Hint } from '@/components/Hint'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { ThemeSelect } from '@/components/ThemeSelect'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'

const DEFAULT_DEVICE = 'system-default'
const ASK_BROWSER = 'ask-browser'

type OnDeviceChange = (kind: DeviceKind, deviceId: string) => void

interface SelectFieldProps {
  id: string
  label: string
  value: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  note?: string
  children: ReactNode
}

function SelectField({ id, label, value, onValueChange, disabled, note, children }: SelectFieldProps) {
  const noteId = `${id}-note`
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full" aria-describedby={note ? noteId : undefined}>
          <span className="min-w-0 flex-1 truncate text-left">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
      {note && (
        <p id={noteId} className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  )
}

interface VolumeSliderProps {
  label: string
  shown: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
}

function VolumeSlider({ label, shown, min, max, step, value, onChange }: VolumeSliderProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{shown}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={([next]) => onChange(next)} />
    </div>
  )
}

interface DeviceSelectProps {
  kind: DeviceKind
  devices: MediaDeviceInfo[]
  selected: string
  onChange: OnDeviceChange
  displayName?: (device: MediaDeviceInfo, index: number) => string
  /** Offers the browser's own device list as a last entry. */
  onAsk?: () => void
}

function DeviceSelect({ kind, devices, selected, onChange, displayName, onAsk }: DeviceSelectProps) {
  const label = DEVICE_LABELS[kind]
  const nameOf = (device: MediaDeviceInfo, index: number) =>
    displayName ? displayName(device, index) : device.label || `${label} ${index + 1}`

  return (
    <SelectField
      id={`${kind}-device`}
      label={label}
      value={selected || DEFAULT_DEVICE}
      onValueChange={(value) => {
        if (value === ASK_BROWSER) onAsk?.()
        else onChange(kind, value === DEFAULT_DEVICE ? '' : value)
      }}
    >
      <SelectItem value={DEFAULT_DEVICE}>System default</SelectItem>
      {devices.map((device, index) => (
        <SelectItem key={device.deviceId} value={device.deviceId} title={nameOf(device, index)}>
          {nameOf(device, index)}
        </SelectItem>
      ))}
      {onAsk && (
        <>
          <SelectSeparator />
          <SelectItem value={ASK_BROWSER}>Choose output device…</SelectItem>
        </>
      )}
    </SelectField>
  )
}

interface SpeakerSelectProps {
  devices: MediaDeviceInfo[]
  selected: string
  onChange: OnDeviceChange
}

// Every browser gets a Speaker row: a list where the browser lists its
// outputs, that list plus the browser's own picker where outputs are
// only exposed through it (Firefox), and an explanation where pages
// cannot choose at all (Safari).
function SpeakerSelect({ devices, selected, onChange }: SpeakerSelectProps) {
  const outputs = audioOutputs
  switch (outputs.picking) {
    case 'listed':
      return <DeviceSelect kind="speaker" devices={devices} selected={selected} onChange={onChange} />
    case 'prompted':
      return (
        <DeviceSelect
          kind="speaker"
          devices={devices}
          selected={selected}
          onChange={onChange}
          onAsk={() => {
            void askForSpeaker(outputs).then((device) => device && onChange('speaker', device.deviceId))
          }}
        />
      )
    case 'system':
      return (
        <SelectField
          id="speaker-device"
          label={DEVICE_LABELS.speaker}
          value={DEFAULT_DEVICE}
          disabled
          note="This browser always plays through the system output. Change it in your computer's sound settings."
        >
          <SelectItem value={DEFAULT_DEVICE}>System output</SelectItem>
        </SelectField>
      )
  }
}

interface DeviceSettingsProps {
  devices: DeviceGroups
  selected: DevicePrefs
  hasMic?: boolean
  onChange: OnDeviceChange
  onResolutionChange: (resolution: CameraResolution) => void
  onVolumeChange: (volume: number) => void
  onMicGainChange: (gain: number) => void
}

// Which microphone and how loud it goes out, which speaker and how loud
// it comes in, which camera and how sharp: the audio rows sit together,
// so the speaker stays in view in a short window. Audio processing
// (echo cancellation, automatic gain, noise suppression) is always on
// and has no controls; the mic slider trims what that processing hands
// over, so it stays useful for a mic that still lands too quiet or too
// hot.
function DeviceSettings({
  devices,
  selected,
  hasMic,
  onChange,
  onResolutionChange,
  onVolumeChange,
  onMicGainChange,
}: DeviceSettingsProps) {
  // Mobile device lists are full of entries the page cannot actually
  // switch (Android communication routes, no output selection at all),
  // so only the camera picker, quality and the volumes are offered there.
  const mobile = isMobileDevice()
  const micDb = Math.round(micGainToDb(selected.micGain))

  return (
    <div className="flex flex-col gap-3">
      {!mobile && <DeviceSelect kind="mic" devices={devices.mics} selected={selected.mic} onChange={onChange} />}
      {hasMic && (
        <VolumeSlider
          label="Mic volume"
          shown={`${micDb > 0 ? '+' : ''}${micDb} dB`}
          min={MIN_MIC_GAIN_DB}
          max={MAX_MIC_GAIN_DB}
          step={1}
          value={micDb}
          onChange={(db) => onMicGainChange(micDbToGain(db))}
        />
      )}
      {!mobile && <SpeakerSelect devices={devices.speakers} selected={selected.speaker} onChange={onChange} />}
      <VolumeSlider
        label="Speaker volume"
        shown={`${Math.round(selected.volume * 100)}%`}
        min={0}
        max={1}
        step={0.05}
        value={selected.volume}
        onChange={onVolumeChange}
      />
      <DeviceSelect
        kind="cam"
        devices={devices.cams}
        selected={selectedCameraId(devices.cams, selected)}
        onChange={onChange}
        displayName={cameraDisplayName}
      />
      {devices.cams.length > 0 && (
        <SelectField
          id="cam-quality"
          label="Camera quality"
          value={selected.resolution}
          onValueChange={(value) => {
            const option = CAMERA_RESOLUTIONS.find((candidate) => candidate.value === value)
            if (option) onResolutionChange(option.value)
          }}
        >
          {CAMERA_RESOLUTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectField>
      )}
    </div>
  )
}

// Scroll shadows: a shade at the top or bottom edge whenever there is
// more to scroll that way. The popover-coloured covers scroll with the
// content and hide each shade once its end is reached.
const SHADE = 'color-mix(in oklch, var(--foreground) 22%, transparent)'
const SCROLL_SHADOWS: CSSProperties = {
  background: [
    'linear-gradient(var(--popover) 30%, transparent) top / 100% 2.5rem no-repeat local',
    'linear-gradient(transparent, var(--popover) 70%) bottom / 100% 2.5rem no-repeat local',
    `radial-gradient(farthest-side at 50% 0, ${SHADE}, transparent) top / 100% 0.75rem no-repeat scroll`,
    `radial-gradient(farthest-side at 50% 100%, ${SHADE}, transparent) bottom / 100% 0.75rem no-repeat scroll`,
  ].join(', '),
}

export function DeviceSettingsPopover({
  translation,
  ...props
}: DeviceSettingsProps & { translation?: ReactNode }) {
  return (
    <Popover>
      <Hint label="Audio and video settings" side="top">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Audio and video settings">
            <Settings2 />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="top"
        align="end"
        className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col p-0"
      >
        <div className="min-h-0 overflow-y-auto p-4" style={SCROLL_SHADOWS}>
          <p className="mb-3 text-sm font-medium">Audio and video</p>
          <DeviceSettings {...props} />
          {translation && (
            <>
              <Separator className="my-3" />
              <Disclosure
                title="Live translation"
                className="border-0"
                contentClassName="px-0 pb-0"
              >
                {translation}
              </Disclosure>
            </>
          )}
          <Separator className="my-4" />
          <ThemeSelect />
        </div>
      </PopoverContent>
    </Popover>
  )
}
