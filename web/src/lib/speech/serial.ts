// One task at a time, in the order they arrived. A speech worker holds a
// session on the machine's GPU or its single WebAssembly thread, and the
// app asks it for work from several places at once (an interim caption
// while a sentence is still being spoken, two listeners' languages, the
// next utterance): queueing here keeps one request in flight per worker,
// so a reply cannot be mistaken for another call's and the machine is
// never asked for two inferences at once.

export class Serial {
  private tail: Promise<unknown> = Promise.resolve()

  /** Runs task once everything queued before it has finished. */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(task)
    this.tail = next.catch(() => {})
    return next
  }
}
