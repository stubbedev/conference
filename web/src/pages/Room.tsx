import { useCallback, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { ControlsBar } from '@/components/ControlsBar'
import { DiagnosticsPanel } from '@/components/DiagnosticsPanel'
import { HudBackdrop } from '@/components/HudBackdrop'
import { DeviceSettingsPopover } from '@/components/MediaSettings'
import { MeetingReady } from '@/components/MeetingReady'
import { MemberAnnouncer } from '@/components/MemberAnnouncer'
import { Prejoin } from '@/components/Prejoin'
import { RoomHeader } from '@/components/RoomHeader'
import { CheckingScreen, ErrorScreen, GateScreen, JoiningScreen } from '@/components/RoomScreens'
import { RoomSidebar } from '@/components/RoomSidebar'
import { Stage } from '@/components/Stage'
import { ThemeToggle } from '@/components/ThemeToggle'
import { TranslationAudio } from '@/components/TranslationAudio'
import { TranslationSettings } from '@/components/TranslationSettings'
import { useDiagnostics } from '@/hooks/diagnostics'
import { useFullscreen } from '@/hooks/fullscreen'
import { useLiveTranslation } from '@/hooks/live-translation'
import { useLocalMedia } from '@/hooks/local-media'
import { useMediaRecovery } from '@/hooks/media-recovery'
import { usePersistentState } from '@/hooks/persistent'
import { useRecording } from '@/hooks/recording'
import { useRoomConnection } from '@/hooks/room-connection'
import { useRoomMembers } from '@/hooks/room-members'
import { useRoomSession } from '@/hooks/room-session'
import { useScreenShare } from '@/hooks/screen-share'
import { useShortcuts } from '@/hooks/shortcuts'
import { useSidePanel } from '@/hooks/side-panel'
import { usePreferredLayers, useStageLayout } from '@/hooks/stage-layout'
import { blurSupported } from '@/lib/blur'
import { storedDisplayName } from '@/lib/names'
import type { RecorderTile } from '@/lib/recorder'
import type { RoomClient } from '@/lib/sfu'
import { heardThrough, LOCAL_SOURCE, tileLabel } from '@/lib/tiles'
import { SCREEN_KIND } from '@/lib/track-kind'
import type { Language } from '@/lib/translate/languages'

const NO_LANGUAGES: Language[] = []

export default function Room() {
  const { slug = '' } = useParams()
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const [meetingReady, setMeetingReady] = useState(() => (routerLocation.state as { created?: boolean } | null)?.created === true)
  const [displayName, setDisplayName] = usePersistentState('conference:name', { parse: storedDisplayName })
  const clientRef = useRef<RoomClient | null>(null)
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const canBlur = blurSupported()

  const media = useLocalMedia(clientRef)
  const { controls, controlsRef, devicePrefs, localStreamRef, turnOff, toggleMic, toggleCam } = media
  const { screenStream, screenStreamRef, toggleShare, toggleScreen } = useScreenShare(
    clientRef,
    controlsRef,
    media.updateControls,
  )
  const session = useRoomSession(slug, media.acquireMedia)
  const { phase, roomInfo, privileged, join } = session
  const live = phase === 'live'
  useMediaRecovery(phase === 'prejoin' || live, media)
  const { fullscreen, toggleFullscreen } = useFullscreen()

  const people = useRoomMembers(clientRef, displayName, controls)
  const { members, selfMember, memberList } = people
  const panel = useSidePanel(clientRef)
  const translation = useLiveTranslation(clientRef, media.localStream, localStreamRef, people.membersRef)
  const { config: translationConfig, langPrefs, changeLangPrefs, translations } = translation
  const translationAvailable = translationConfig.available
  const layout = useStageLayout(media.localStream, screenStream, people.tiles)
  const { allTiles, pinnedKey } = layout

  const recorderTiles = useMemo<RecorderTile[]>(
    () =>
      allTiles.map((tile) => ({
        key: tile.key,
        stream: tile.stream,
        name: tileLabel(tile, displayName, members),
        local: tile.sourceId === LOCAL_SOURCE,
        pinned: pinnedKey === tile.key,
        screen: tile.kind === SCREEN_KIND,
        heard: heardThrough(tile, translations).stream,
      })),
    [allTiles, displayName, members, pinnedKey, translations],
  )
  const recording = useRecording(slug, clientRef, recorderTiles)

  const listenForced = useCallback(
    (client: RoomClient) =>
      client.on('forced', ({ action }) => {
        if (action === 'mute') {
          toast('The host muted your microphone')
          turnOff('mic')
        } else if (action === 'cam') {
          toast('The host turned off your camera')
          turnOff('cam')
        } else {
          toast('The host stopped your screen share')
          if (controlsRef.current.sharing) void toggleShare()
        }
      }),
    [controlsRef, turnOff, toggleShare],
  )

  const binders = useMemo(
    () => [people.bind, panel.bind, recording.bind, translation.bind],
    [people.bind, panel.bind, recording.bind, translation.bind],
  )
  const liveListeners = useMemo(
    () => [translation.listenLangSet, listenForced],
    [translation.listenLangSet, listenForced],
  )
  const { connectClient, clientGeneration, leave } = useRoomConnection({
    slug,
    displayName,
    live,
    clientRef,
    sessionRef: session.sessionRef,
    roomKeyRef: session.roomKeyRef,
    localStreamRef,
    screenStreamRef,
    binders,
    liveListeners,
    stopRecording: recording.stopRecording,
    stopTranslation: translation.stopTranslation,
    onReconnected: people.keepPresent,
    onLost: people.reset,
  })
  usePreferredLayers(clientRef, live, clientGeneration, allTiles, pinnedKey)
  useShortcuts(phase, { toggleMic, toggleCam, toggleChat: panel.toggleChat, toggleFullscreen })

  const passwordProtected = Boolean(roomInfo?.requiresPassword)
  const inviteLink = () =>
    passwordProtected || !session.roomKeyText
      ? `${window.location.origin}/r/${slug}`
      : `${window.location.origin}/r/${slug}#k=${session.roomKeyText}`

  const copyInvite = async () => {
    await navigator.clipboard.writeText(inviteLink())
    toast.success('Joining link copied')
  }

  const diagnostics = useDiagnostics(() => void copyInvite())

  const joinCall = () => void join(() => connectClient(''))

  const settingsPopover = useMemo(
    () => (
      <DeviceSettingsPopover
        devices={media.devices}
        selected={devicePrefs}
        hasMic={media.hasMic}
        onChange={media.handleDeviceChange}
        onResolutionChange={media.handleResolutionChange}
        onVolumeChange={media.handleVolumeChange}
        onMicGainChange={media.handleMicGainChange}
        translation={
          translationAvailable ? (
            <TranslationSettings config={translationConfig} prefs={langPrefs} onChange={changeLangPrefs} />
          ) : undefined
        }
      />
    ),
    [
      translationAvailable,
      translationConfig,
      langPrefs,
      changeLangPrefs,
      media.devices,
      devicePrefs,
      media.hasMic,
      media.handleDeviceChange,
      media.handleResolutionChange,
      media.handleVolumeChange,
      media.handleMicGainChange,
    ],
  )

  if (phase === 'checking') return <CheckingScreen />

  if (phase === 'gate') {
    return (
      <GateScreen
        busy={session.gateBusy}
        roomName={roomInfo?.name ?? ''}
        error={session.gateError}
        onSubmit={session.submitPassword}
      />
    )
  }

  if (phase === 'error') return <ErrorScreen message={session.fatalError} onBack={() => navigate('/')} />

  if (phase === 'prejoin') {
    return (
      <>
        <HudBackdrop />
        <div className="absolute top-3 right-3 z-10">
          <ThemeToggle />
        </div>
        <Prejoin
          roomName={roomInfo?.name ?? ''}
          slug={slug}
          stream={media.localStream}
          mediaError={media.mediaError}
          mediaBusy={media.mediaBusy}
          micAvailable={media.micAvailable}
          camAvailable={media.camAvailable}
          name={displayName}
          mic={controls.mic}
          cam={controls.cam}
          blur={devicePrefs.blur}
          canBlur={canBlur}
          onNameChange={setDisplayName}
          onToggleMic={toggleMic}
          onToggleCam={toggleCam}
          onToggleBlur={media.onToggleBlur}
          onRetryMedia={() => void media.acquireMedia()}
          onJoin={joinCall}
          translation={
            translationAvailable ? (
              <TranslationSettings config={translationConfig} prefs={langPrefs} onChange={changeLangPrefs} prominent />
            ) : undefined
          }
        />
      </>
    )
  }

  if (phase === 'joining') return <JoiningScreen />

  return (
    <div className="relative flex h-dvh flex-col bg-muted/40">
      <RoomHeader
        title={roomInfo?.name || slug}
        onTitleTap={diagnostics.onTitleTap}
        recorder={recording.recorder}
        translation={translationConfig}
        translationBy={translation.translationBy}
        selfId={people.selfId}
        members={members}
        translatorStatus={translation.translatorStatus}
        translationFailure={translation.translationFailure}
        onDismissFailure={translation.dismissFailure}
        lang={langPrefs.lang}
      />

      <div className="relative flex min-h-0 flex-1">
        <Stage
          layout={layout}
          selfMember={selfMember}
          members={members}
          selfId={people.selfId}
          displayName={displayName}
          captions={translation.captions}
          translations={translations}
          speaker={devicePrefs.speaker}
          volume={devicePrefs.volume}
        />

        {panel.sidebar && (
          <RoomSidebar
            tab={panel.sidebar}
            unread={panel.unread}
            onTab={panel.showSidebar}
            onClose={panel.closeSidebar}
            members={memberList}
            selfId={selfMember.id}
            canModerate={privileged}
            onModerate={people.moderate}
            languages={translationAvailable ? translationConfig.languages : NO_LANGUAGES}
            memberLangs={translation.memberLangs}
            onSetLanguage={translation.setMemberLanguage}
            messages={panel.messages}
            onSend={panel.sendChat}
          />
        )}
      </div>

      <MemberAnnouncer members={memberList} />
      <ControlsBar
        roomName={roomInfo?.name || slug}
        peopleCount={memberList.length}
        peopleOpen={panel.sidebar === 'people'}
        onTogglePeople={panel.togglePeople}
        mic={controls.mic}
        cam={controls.cam}
        micAvailable={media.micAvailable}
        camAvailable={media.camAvailable}
        sharing={controls.sharing}
        blur={devicePrefs.blur}
        canBlur={canBlur}
        onBlur={media.onToggleBlur}
        chatOpen={panel.chatOpen}
        unread={panel.unread}
        fullscreen={fullscreen}
        canShare={canShare}
        canRecord={recording.canRecord}
        recording={recording.recording}
        onMic={toggleMic}
        onCam={toggleCam}
        onShare={toggleScreen}
        onRecord={recording.toggleRecording}
        canTranslate={translationAvailable}
        translating={translation.translationBy !== null}
        onTranslate={translation.toggleTranslation}
        onLeave={leave}
        onToggleChat={panel.toggleChat}
        onToggleFullscreen={toggleFullscreen}
      >
        {settingsPopover}
      </ControlsBar>
      {allTiles.map((tile) => {
        const heard = heardThrough(tile, translations)
        if (heard.through === 'own') return null
        return <TranslationAudio key={tile.key} stream={heard.stream} sinkId={devicePrefs.speaker} volume={devicePrefs.volume} />
      })}
      {meetingReady && (
        <MeetingReady
          link={inviteLink()}
          passwordProtected={passwordProtected}
          onCopy={copyInvite}
          onClose={() => setMeetingReady(false)}
        />
      )}
      {diagnostics.open && <DiagnosticsPanel clientRef={clientRef} errorsRef={diagnostics.errorsRef} />}
    </div>
  )
}
