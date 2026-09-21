import { useEffect } from 'react'
import { Ear, Settings2 } from 'lucide-react'

import {
  CAMERA_RESOLUTIONS,
  DEVICE_LABELS,
  eqPresetFor,
  EQ_PRESETS,
  isMobileDevice,
  MAX_EQ_DB,
  MAX_MIC_GAIN_DB,
  micDbToGain,
  micGainToDb,
  MIN_EQ_DB,
  MIN_MIC_GAIN_DB,
  supportsSinkSelection,
  useMicMeter,
  type CameraResolution,
  type DeviceGroups,
  type DeviceKind,
  type DevicePrefs,
  type EqualizerBands,
  type EqualizerPreset,
  type MicMeterSource,
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
}

function DeviceSelect({ kind, devices, selected, onChange }: DeviceSelectProps) {
  const label = DEVICE_LABELS[kind]

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
            <SelectItem
              key={device.deviceId}
              value={device.deviceId}
              title={device.label || `${label} ${index + 1}`}
            >
              {device.label || `${label} ${index + 1}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

interface MicGainControlProps {
  gain: number
  meter: MicMeterSource
  onChange: (gain: number) => void
  onMonitor: (on: boolean) => void
}

// Input gain for your own microphone: a dB slider over the Web Audio
// gain graph plus a live post-gain level meter with a clipping
// indicator, so the classic "can you hear me?" case is fixable without
// leaving the call. Hold-to-test routes the processed mic to your own
// speakers for as long as the button is held.
function MicGainControl({ gain, meter, onChange, onMonitor }: MicGainControlProps) {
  const { level, clipping } = useMicMeter(meter)
  const db = Math.round(micGainToDb(gain))

  useEffect(() => () => onMonitor(false), [onMonitor])

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">Mic volume</Label>
        <span
          className={
            clipping
              ? 'text-xs font-medium text-red-500'
              : 'text-xs tabular-nums text-muted-foreground'
          }
        >
          {clipping ? 'Clipping' : `${db > 0 ? '+' : ''}${db} dB`}
        </span>
      </div>
      <Slider
        min={MIN_MIC_GAIN_DB}
        max={MAX_MIC_GAIN_DB}
        step={1}
        value={[db]}
        onValueChange={([next]) => onChange(micDbToGain(next))}
      />
      <div className="flex items-center gap-2">
        <div aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={clipping ? 'h-full rounded-full bg-red-500' : 'h-full rounded-full bg-emerald-500'}
            style={{ width: `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%` }}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          title="Hold to hear yourself (headphones recommended)"
          onPointerDown={() => onMonitor(true)}
          onPointerUp={() => onMonitor(false)}
          onPointerLeave={() => onMonitor(false)}
          onPointerCancel={() => onMonitor(false)}
        >
          <Ear className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

interface EqualizerControlProps {
  bands: EqualizerBands
  onChange: (bands: EqualizerBands) => void
}

// Three-band EQ over the live mic graph: low shelf, presence peak,
// high shelf. Flat is the default and bypasses the filters entirely.
function EqualizerControl({ bands, onChange }: EqualizerControlProps) {
  const preset = eqPresetFor(bands)

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground">Equalizer</Label>
        <Select
          value={preset}
          onValueChange={(value) =>
            onChange(EQ_PRESETS[value as Exclude<EqualizerPreset, 'custom'>])
          }
        >
          <SelectTrigger className="h-7 w-28">
            <span className="min-w-0 flex-1 truncate text-left">
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="flat">Flat</SelectItem>
            <SelectItem value="voice">Voice</SelectItem>
            <SelectItem value="warm">Warm</SelectItem>
            <SelectItem value="bright">Bright</SelectItem>
            <SelectItem value="custom" disabled>
              Custom
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {(['low', 'mid', 'high'] as const).map((band) => (
          <div key={band} className="flex min-w-0 flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <Label className="text-xs capitalize text-muted-foreground">{band}</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {bands[band] > 0 ? '+' : ''}
                {bands[band]}
              </span>
            </div>
            <Slider
              min={MIN_EQ_DB}
              max={MAX_EQ_DB}
              step={1}
              value={[bands[band]]}
              onValueChange={([next]) => onChange({ ...bands, [band]: next })}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

interface DeviceSettingsProps {
  devices: DeviceGroups
  selected: DevicePrefs
  micMeter?: MicMeterSource | null
  onChange: (kind: DeviceKind, deviceId: string) => void
  onResolutionChange: (resolution: CameraResolution) => void
  onVolumeChange: (volume: number) => void
  onMicGainChange: (gain: number) => void
  onEqualizerChange: (bands: EqualizerBands) => void
  onMicMonitor: (on: boolean) => void
}

export function DeviceSettings({
  devices,
  selected,
  micMeter,
  onChange,
  onResolutionChange,
  onVolumeChange,
  onMicGainChange,
  onEqualizerChange,
  onMicMonitor,
}: DeviceSettingsProps) {
  // Mobile device lists are full of entries the page cannot actually
  // switch (Android communication routes, no output selection at all),
  // so only the camera picker and volume are offered there.
  const mobile = isMobileDevice()

  return (
    <div className="flex flex-col gap-3">
      {!mobile && (
        <DeviceSelect kind="mic" devices={devices.mics} selected={selected.mic} onChange={onChange} />
      )}
      <DeviceSelect kind="cam" devices={devices.cams} selected={selected.cam} onChange={onChange} />
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
      {micMeter && (
        <>
          <MicGainControl
            gain={selected.micGain}
            meter={micMeter}
            onChange={onMicGainChange}
            onMonitor={onMicMonitor}
          />
          <EqualizerControl bands={selected.eqBands} onChange={onEqualizerChange} />
        </>
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
