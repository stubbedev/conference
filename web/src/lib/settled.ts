// Waits for a promise to finish, whichever way it does. Its failure is
// for whoever holds the promise itself to handle; this is for code that
// only has to go after it, and would otherwise fail a second time for
// the same reason.
export function settled(promise: Promise<unknown>): Promise<void> {
  const done = () => {}
  return promise.then(done, done)
}
