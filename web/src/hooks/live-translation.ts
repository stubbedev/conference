import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'

import { useLatest } from '@/hooks/latest'
import { usePersistentState } from '@/hooks/persistent'
import { api, type TranslationConfig } from '@/lib/api'
import { browserEngines } from '@/lib/speech/browser'
import { LocalTranslator } from '@/lib/speech/local'
import { message } from '@/lib/speech/runtime'
import { StandInEngines } from '@/lib/speech/standin'
import { translationKindLang, type MemberInfo, type RoomClient } from '@/lib/sfu'
import { LOCAL_SOURCE } from '@/lib/tiles'
import { ServerTranslator } from '@/lib/translate/bridge'
import { DEFAULT_LANGUAGE, languageName } from '@/lib/translate/languages'
import type { Translator, TranslatorEvents } from '@/lib/translate/translator'
import { isVoiceChoice, type LangPrefs, type RoomCaption, type TranslatorStatus } from '@/lib/translate/types'

const CAPTION_HOLD_MS = 5000
const INTERIM_HOLD_MS = 10_000
const CAPTION_PRUNE_MS = 500
const LANG_PREFS_KEY = 'conference:translation'

const TRANSLATION_CHECKING: TranslationConfig = {
  available: false,
  reason: 'Checking whether live translation is available…',
  mode: 'server',
  languages: [],
  external: false,
}
function translationUnknown(err: unknown): TranslationConfig {
  return {
    available: false,
    reason: `Live translation is unavailable: the server configuration could not be read: ${message(err)}`,
    mode: 'server',
    languages: [],
    external: false,
  }
}

export interface ShownCaption {
  segId: string
  text: string
  final: boolean
  at: number
}

export interface TranslatedVoice {
  sourceId: string
  stream: MediaStream
}

function storedLangChoice(): boolean {
  try {
    return localStorage.getItem(LANG_PREFS_KEY) !== null
  } catch {
    return false
  }
}

function browserLanguage(codes: readonly string[]): string | undefined {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const code = tag.toLowerCase().split('-')[0]
    if (codes.includes(code)) return code
  }
  return undefined
}

function localMicTrack(stream: MediaStream | null): MediaStreamTrack | null {
  return stream?.getAudioTracks()[0] ?? null
}

function migrateLangPrefs(stored: LangPrefs): LangPrefs {
  return {
    lang: typeof stored.lang === 'string' && stored.lang ? stored.lang : DEFAULT_LANGUAGE,
    voice: typeof stored.voice === 'boolean' ? stored.voice : true,
    subtitles: typeof stored.subtitles === 'boolean' ? stored.subtitles : true,
    voiceChoice: isVoiceChoice(stored.voiceChoice) ? stored.voiceChoice : 'female',
  }
}

function buildTranslator(
  config: TranslationConfig,
  prefs: LangPrefs,
  events: TranslatorEvents,
): Translator | null {
  if (config.mode !== 'browser') return new ServerTranslator(prefs, events)
  if (config.fake) return new LocalTranslator(prefs, events, new StandInEngines())

  if (!config.models) return null
  return new LocalTranslator(prefs, events, browserEngines(config.models, config.languages))
}

export function useLiveTranslation(
  clientRef: RefObject<RoomClient | null>,
  localStream: MediaStream | null,
  localStreamRef: RefObject<MediaStream | null>,
  membersRef: RefObject<MemberInfo[]>,
) {
  const [translation, setTranslation] = useState<TranslationConfig>(TRANSLATION_CHECKING)
  const [translationBy, setTranslationBy] = useState<string | null>(null)
  const [captions, setCaptions] = useState<Record<string, ShownCaption>>({})
  const [translationStreams, setTranslationStreams] = useState<Record<string, Record<string, MediaStream>>>({})
  const [memberLangs, setMemberLangs] = useState<Record<string, string>>({})
  const [voicePlaying, setVoicePlaying] = useState<Record<string, true>>({})
  const [translatorStatus, setTranslatorStatus] = useState<TranslatorStatus | null>(null)
  const [translationFailure, setTranslationFailure] = useState('')
  const voiceEndsRef = useRef(new Map<string, number>())
  const translatorRef = useRef<Translator | null>(null)
  const langChosenRef = useRef(storedLangChoice())
  const [langPrefs, setLangPrefs] = usePersistentState<LangPrefs>(
    LANG_PREFS_KEY,
    { lang: DEFAULT_LANGUAGE, voice: true, subtitles: true, voiceChoice: 'female' },
    migrateLangPrefs,
  )
  const translationRef = useLatest(translation)
  const langPrefsRef = useLatest(langPrefs)

  useEffect(() => {
    api
      .config()
      .then((config) => setTranslation(config.translation))
      .catch((err: unknown) => {
        console.warn('live translation: reading the server configuration failed:', err)
        setTranslation(translationUnknown(err))
      })
  }, [])

  useEffect(() => {
    return () => {
      translatorRef.current?.stop().catch((err: unknown) => console.warn('live translation could not stop cleanly when leaving the room:', err))
    }
  }, [])

  useEffect(() => {
    const codes = translation.languages.map((language) => language.code)
    if (codes.length === 0) return
    if (!langChosenRef.current) {
      langChosenRef.current = true
      const preferred = browserLanguage(codes)
      if (preferred && preferred !== langPrefs.lang) {
        setLangPrefs({ ...langPrefs, lang: preferred })
        return
      }
    }
    if (codes.includes(langPrefs.lang)) return
    setLangPrefs({ ...langPrefs, lang: codes.includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : codes[0] })
  }, [translation, langPrefs, setLangPrefs])

  const handleRoomCaption = useCallback(
    (caption: RoomCaption) => {
      const prefs = langPrefsRef.current
      if (caption.lang !== prefs.lang) return
      if (caption.k === 'caption') {
        if (!prefs.subtitles) return
        const shown: ShownCaption = {
          segId: caption.segId,
          text: caption.text,
          final: caption.final,
          at: Date.now(),
        }
        setCaptions((prev) => ({ ...prev, [caption.speaker]: shown }))
        return
      }
      const { speaker, startInMs, durationMs } = caption
      const ends = Date.now() + startInMs + durationMs
      voiceEndsRef.current.set(speaker, Math.max(voiceEndsRef.current.get(speaker) ?? 0, ends))
      window.setTimeout(() => setVoicePlaying((prev) => ({ ...prev, [speaker]: true })), startInMs)
      window.setTimeout(() => {
        if (Date.now() < (voiceEndsRef.current.get(speaker) ?? 0) - 50) return
        setVoicePlaying(({ [speaker]: _ended, ...rest }) => rest)
      }, startInMs + durationMs)
    },
    [langPrefsRef],
  )

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      setCaptions((prev) => {
        const kept = Object.entries(prev).filter(
          ([, caption]) => now - caption.at < (caption.final ? CAPTION_HOLD_MS : INTERIM_HOLD_MS),
        )
        return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
      })
    }, CAPTION_PRUNE_MS)
    return () => window.clearInterval(timer)
  }, [])

  const stopTranslation = useCallback(async () => {
    const translator = translatorRef.current
    translatorRef.current = null
    setTranslatorStatus(null)
    await translator?.stop()
  }, [])

  const startTranslation = useCallback(
    (client: RoomClient) => {
      if (translatorRef.current) return
      setTranslationFailure('')
      const events: TranslatorEvents = {
        onCaption: handleRoomCaption,
        onFailure: (reason) => {
          toast.error(reason, { duration: 10_000 })
          setTranslationFailure(reason)
          void stopTranslation()
        },
        onStatus: setTranslatorStatus,
        onStream: (speaker, lang, track) =>
          setTranslationStreams((prev) => ({
            ...prev,
            [speaker]: { ...prev[speaker], [lang]: new MediaStream([track]) },
          })),
      }

      const translator = buildTranslator(translation, langPrefsRef.current, events)
      if (!translator) {
        const reason = 'Live translation is set to run in the browser, but the server names no models to run it with.'
        events.onFailure(reason)
        return
      }

      translatorRef.current = translator
      translator.attach(client)
      translator.start(localMicTrack(localStreamRef.current))
    },
    [translation, langPrefsRef, localStreamRef, handleRoomCaption, stopTranslation],
  )

  const toggleTranslation = useCallback(() => {
    clientRef.current?.announceTranslating(translationBy === null)
  }, [clientRef, translationBy])

  useEffect(() => {
    clientRef.current?.setLangPrefs(langPrefs)
    translatorRef.current?.setSelfPrefs(langPrefs)
  }, [clientRef, langPrefs])

  const changeLangPrefs = useCallback(
    (prefs: LangPrefs) => {
      langChosenRef.current = true
      setLangPrefs(prefs)
      setCaptions({})
    },
    [setLangPrefs],
  )

  const setMemberLanguage = useCallback(
    (target: string, lang: string) => void clientRef.current?.setMemberLanguage(target, lang),
    [clientRef],
  )

  const dismissFailure = useCallback(() => setTranslationFailure(''), [])

  useEffect(() => {
    translatorRef.current?.setLocalMic(localMicTrack(localStream))
  }, [localStream])

  const bind = useCallback(
    (client: RoomClient) => {
      client.setLangPrefs(langPrefsRef.current)
      translatorRef.current?.attach(client)
      let translatingAtJoin = false

      client.on('welcome', ({ translatingBy }) => {
        setTranslationBy(translatingBy || null)
        translatingAtJoin = Boolean(translatingBy)
        setMemberLangs({})
      })
      client.on('member-left', ({ id }) => {
        setMemberLangs(({ [id]: _left, ...rest }) => rest)
        setTranslationStreams(({ [id]: _gone, ...rest }) => rest)
      })
      client.on('track', ({ sourceId, stream, kind }) => {
        const lang = translationKindLang(kind)
        if (lang === null) return
        setTranslationStreams((prev) => ({ ...prev, [sourceId]: { ...prev[sourceId], [lang]: stream } }))
      })
      client.on('caption', ({ caption }) => {
        const translator = translatorRef.current
        if (translator) translator.receive(caption)
        else if (caption.k !== 'translation') handleRoomCaption(caption)
      })
      client.on('lang', ({ from, prefs }) => setMemberLangs((prev) => ({ ...prev, [from]: prefs.lang })))
      client.on('translating', ({ from, on }) => {
        setTranslationBy(on ? from : null)
        if (on) startTranslation(client)
        else {
          setTranslationStreams({})
          void stopTranslation()
        }
        if (from === client.memberId) {
          if (on) toast.success('Live translation started')
          else toast('Live translation stopped')
          return
        }
        const name = client.memberName(from)
        if (on) toast(`${name} started live translation`)
        else toast(`${name} stopped live translation`)
      })

      return (published: MediaStream) => {
        if (translatorRef.current) translatorRef.current.start(localMicTrack(published))
        else if (translatingAtJoin) startTranslation(client)
      }
    },
    [langPrefsRef, handleRoomCaption, startTranslation, stopTranslation],
  )

  const listenLangSet = useCallback(
    (client: RoomClient) =>
      client.on('lang-set', ({ from, lang }) => {
        if (!translationRef.current.languages.some((language) => language.code === lang)) return
        langChosenRef.current = true
        setLangPrefs((prefs) => ({ ...prefs, lang }))
        setCaptions({})
        const host = membersRef.current.find((member) => member.id === from)?.name ?? 'The host'
        toast(`${host} set your language to ${languageName(translationRef.current.languages, lang)}`, {
          description: 'You can change it in the settings.',
        })
      }),
    [setLangPrefs, membersRef, translationRef],
  )

  const speaksOtherLanguage = useCallback(
    (sourceId: string) => {
      if (!translationBy || sourceId === LOCAL_SOURCE) return false
      const lang = memberLangs[sourceId]
      return Boolean(lang) && lang !== langPrefs.lang
    },
    [translationBy, memberLangs, langPrefs.lang],
  )

  const voices = useMemo<TranslatedVoice[]>(
    () =>
      Object.entries(translationStreams)
        .filter(([sourceId, langs]) => speaksOtherLanguage(sourceId) && langs[langPrefs.lang])
        .map(([sourceId, langs]) => ({ sourceId, stream: langs[langPrefs.lang] })),
    [translationStreams, speaksOtherLanguage, langPrefs.lang],
  )

  return {
    config: translation,
    langPrefs,
    changeLangPrefs,
    translationBy,
    memberLangs,
    setMemberLanguage,
    captions,
    voicePlaying,
    translatorStatus,
    translationFailure,
    dismissFailure,
    toggleTranslation,
    stopTranslation,
    speaksOtherLanguage,
    voices,
    bind,
    listenLangSet,
  }
}
