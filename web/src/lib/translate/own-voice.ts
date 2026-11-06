// A speaker's own voice, recorded before the call: a few sentences read
// aloud, which the speech service clones their translated voice from.
// It stays in this browser: in memory, or, only if the speaker asks,
// in this device's IndexedDB. It is sent to the speech service while
// live translation runs, which keeps it for that connection only.

import captureWorkletUrl from '@/lib/translate/pcm-capture.worklet.ts?worker&url'

export const SAMPLE_RATE = 16_000
/** Long enough for a good clone; the service needs at least 6 s of it. */
export const SAMPLE_SECONDS = 15
export const MIN_SAMPLE_SECONDS = 6

export interface OwnVoiceSample {
  /** 16 kHz mono PCM16. */
  pcm: Int16Array<ArrayBuffer>
  /** The language it is spoken in. */
  lang: string
}

// What to read aloud, by language: meeting-like, with a question and a
// livelier sentence for intonation, and the language's typical sounds,
// about 15 s at a normal pace. Any language works; the speech service
// transcribes what was actually said.
const READING: Record<string, string> = {
  en: 'Good morning, everyone, and thanks for joining. This week we finally finished the new search feature, and the first results look really promising! What do you think about showing it to our customers next Thursday?',
  de: 'Guten Morgen zusammen, schön, dass Sie dabei sind. Diese Woche haben wir die neue Suchfunktion endlich fertiggestellt, und die ersten Ergebnisse für unsere Kunden sehen wirklich großartig aus! Wollen wir sie nächsten Donnerstag zeigen?',
  sv: 'God morgon, och tack för att du är med. Den här veckan blev den nya sökfunktionen äntligen klar efter sju veckor, och de första resultaten ser riktigt lovande ut! Vad tycker du om att visa den för kunderna på torsdag den tjugonde?',
  da: 'Godmorgen, og tak fordi du er med. I denne uge blev den nye søgefunktion endelig færdig, og de første resultater ser virkelig lovende ud! Hvad synes du om at vise den til kunderne på torsdag?',
}

export const READING_TIPS = "Read it naturally, as you'd say it in a meeting. A quiet room, a normal distance from the microphone."

/** The text to read, or for other languages a prompt to talk freely; read reports which. */
export function readingText(lang: string): { text: string; read: boolean } {
  const text = READING[lang]
  if (text) return { text, read: true }
  return {
    text: "Tell us, in your own language, what you're working on this week and what comes next, as you would in a meeting.",
    read: false,
  }
}

/** Records the microphone until stop() or SAMPLE_SECONDS, at 16 kHz. */
export class SampleRecorder {
  private context: AudioContext | null = null
  private chunks: Int16Array[] = []
  private samples = 0
  private finished: ((pcm: Int16Array<ArrayBuffer>) => void) | null = null

  private readonly onProgress: (seconds: number) => void

  constructor(onProgress: (seconds: number) => void) {
    this.onProgress = onProgress
  }

  async start(track: MediaStreamTrack): Promise<Int16Array<ArrayBuffer>> {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.context = context
    await context.audioWorklet.addModule(captureWorkletUrl)
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const node = new AudioWorkletNode(context, 'pcm-capture')
    // A worklet only runs while the graph pulls it, so it feeds a muted gain.
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(node).connect(mute).connect(context.destination)

    const done = new Promise<Int16Array<ArrayBuffer>>((resolve) => {
      this.finished = resolve
    })
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const chunk = new Int16Array(ev.data)
      this.chunks.push(chunk)
      this.samples += chunk.length
      this.onProgress(this.samples / SAMPLE_RATE)
      if (this.samples >= SAMPLE_SECONDS * SAMPLE_RATE) this.stop()
    }
    return done
  }

  stop(): void {
    const finished = this.finished
    if (!finished) return
    this.finished = null
    void this.context?.close()
    this.context = null
    const pcm = new Int16Array(this.samples)
    let offset = 0
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    finished(pcm)
  }
}

// "Remember my voice on this device": IndexedDB, this site only.
const DB = 'conference'
const STORE = 'own-voice'
const KEY = 'sample'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
  } finally {
    db.close()
  }
}

export async function rememberSample(sample: OwnVoiceSample): Promise<void> {
  await withStore('readwrite', (store) => store.put({ pcm: sample.pcm.buffer, lang: sample.lang }, KEY))
}

export async function rememberedSample(): Promise<OwnVoiceSample | null> {
  try {
    const stored = await withStore<{ pcm?: ArrayBuffer; lang?: string } | undefined>('readonly', (store) => store.get(KEY))
    if (!stored?.pcm || typeof stored.lang !== 'string') return null
    return { pcm: new Int16Array(stored.pcm), lang: stored.lang }
  } catch {
    return null
  }
}

export async function forgetSample(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(KEY))
  } catch {
    // Nothing stored, or storage unavailable: nothing to delete.
  }
}
