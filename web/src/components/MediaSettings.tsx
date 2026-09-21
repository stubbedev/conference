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
  supportsSinkSelection,
  type CameraResolution,
  type DeviceGroups,
  type DeviceKind,
  type DevicePrefs,
} from '@/hooks/media'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'

const DEFAULT_DEVICE = 'system-default'

interface DeviceSelectProps {
  kind: DeviceKind
  devices: MediaDeviceInfo[]
  selected: string
  onChange: (kind: DeviceKind, deviceId: string) => void
  displayName?: (device: MediaDeviceInfo, index: number) => string
}

function DeviceSelect({ kind, devices, selected, onChange, displayName }: DeviceSelectProps) {
  const label = DEVICE_LABELS[kind]
  const nameOf = (device: MediaDeviceInfo, index: number) =>
    displayName ? displayName(device, index) : device.label || `${label} ${index + 1}`

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={`${kind}-device`} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select
        value={selected || DEFAULT_DEVICE}
        onValueChange={(value) => onChange(kind, value === DEFAULT_DEVICE ? '' : value)}
      >
        <SelectTrigger id={`${kind}-device`} className="w-full">
          <span className="min-w-0 flex-1 truncate text-left">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_DEVICE}>System default</SelectItem>
          {devices.map((device, index) => (
            <SelectItem key={device.deviceId} value={device.deviceId} title={nameOf(device, index)}>
              {nameOf(device, index)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

interface DeviceSettingsProps {
  devices: DeviceGroups
  selected: DevicePrefs
  hasMic?: boolean
  onChange: (kind: DeviceKind, deviceId: string) => void
  onResolutionChange: (resolution: CameraResolution) => void
  onVolumeChange: (volume: number) => void
  onMicGainChange: (gain: number) => void
}

// Which microphone and how loud it goes out, which camera and how
// sharp, which speaker and how loud it comes in. Audio processing
// (echo cancellation, automatic gain, noise suppression) is always on
// and has no controls; the mic slider trims what that processing hands
// over, so it stays useful for a mic that still lands too quiet or too
// hot.
export function DeviceSettings({
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
      {!mobile && (
        <DeviceSelect kind="mic" devices={devices.mics} selected={selected.mic} onChange={onChange} />
      )}
      {hasMic && (
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Mic volume</Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {micDb > 0 ? '+' : ''}
              {micDb} dB
            </span>
          </div>
          <Slider
            min={MIN_MIC_GAIN_DB}
            max={MAX_MIC_GAIN_DB}
            step={1}
            value={[micDb]}
            onValueChange={([next]) => onMicGainChange(micDbToGain(next))}
          />
        </div>
      )}
      <DeviceSelect
        kind="cam"
        devices={devices.cams}
        selected={selectedCameraId(devices.cams, selected)}
        onChange={onChange}
        displayName={cameraDisplayName}
      />
      {devices.cams.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="cam-quality" className="text-xs text-muted-foreground">
            Camera quality
          </Label>
          <Select
            value={selected.resolution}
            onValueChange={(value) => onResolutionChange(value as CameraResolution)}
          >
            <SelectTrigger id="cam-quality" className="w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              {CAMERA_RESOLUTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {supportsSinkSelection() && !mobile && (
        <DeviceSelect
          kind="speaker"
          devices={devices.speakers}
          selected={selected.speaker}
          onChange={onChange}
        />
      )}
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Speaker volume</Label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {Math.round(selected.volume * 100)}%
          </span>
        </div>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[selected.volume]}
          onValueChange={([volume]) => onVolumeChange(volume)}
        />
      </div>
    </div>
  )
}

export function DeviceSettingsPopover(props: DeviceSettingsProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" title="Audio and video settings">
          <Settings2 />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80">
        <p className="mb-3 text-sm font-medium">Audio and video</p>
        <DeviceSettings {...props} />
      </PopoverContent>
    </Popover>
  )
}
