export interface Publisher<S> {
  connect(): Promise<void>
  publish(stream: S): Promise<void>
}

export async function connectAndPublish<S>(client: Publisher<S>, currentStream: () => S): Promise<S> {
  await client.connect()
  const stream = currentStream()
  await client.publish(stream)
  return stream
}
