const DB_NAME = 'conference'
const STORE = 'roompass'
const RETIRED_PLAINTEXT_PREFIX = 'conference:roompw:'

let opened: Promise<IDBDatabase> | null = null

function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  return opened
}

async function write(op: (store: IDBObjectStore) => void): Promise<void> {
  const tx = (await database()).transaction(STORE, 'readwrite')
  op(tx.objectStore(STORE))
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function savedRoomPassword(slug: string): Promise<CryptoKey | null> {
  try {
    const get = (await database()).transaction(STORE).objectStore(STORE).get(slug)
    const value = await new Promise<unknown>((resolve, reject) => {
      get.onsuccess = () => resolve(get.result)
      get.onerror = () => reject(get.error)
    })
    return value instanceof CryptoKey ? value : null
  } catch (err) {
    console.warn(`roompass: reading the saved password of room ${slug}`, err)
    return null
  }
}

export async function rememberRoomPassword(slug: string, password: CryptoKey): Promise<void> {
  if (password.extractable) throw new Error('roompass: refusing to store an extractable password key')
  try {
    await write((store) => store.put(password, slug))
  } catch (err) {
    console.warn(`roompass: saving the password of room ${slug}`, err)
  }
}

export async function forgetRoomPassword(slug: string): Promise<void> {
  try {
    await write((store) => store.delete(slug))
  } catch (err) {
    console.warn(`roompass: forgetting the password of room ${slug}`, err)
  }
}

export function purgePlaintextRoomPasswords(): void {
  try {
    const retired = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
      (key): key is string => key !== null && key.startsWith(RETIRED_PLAINTEXT_PREFIX),
    )
    for (const key of retired) localStorage.removeItem(key)
  } catch (err) {
    console.warn('roompass: purging plaintext room passwords', err)
  }
}
