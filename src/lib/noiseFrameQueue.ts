type FrameMessage = { type: "process"; sequence: number; buffer: ArrayBuffer };

/** Serialize recurrent inference and invalidate queued/in-flight audio across sequence gaps. */
export function connectNoiseFrames(port: MessagePort, options: {
  frameLength: number;
  latencySamples: number;
  process(input: Float32Array): Float32Array | Promise<Float32Array>;
  reset(): void;
  onError(error: unknown): void;
}) {
  let queue: Array<{ frame: FrameMessage; generation: number }> = [];
  let generation = 0;
  let receivedSequence: number | undefined;
  let streamStart = 0;
  let resetPending = false;
  let disposed = false;
  let failed = false;
  let processing: Promise<void> | undefined;
  const warmupFrames = Math.ceil(options.latencySamples / options.frameLength);
  const recycle = (frame: FrameMessage) => {
    if (!disposed) port.postMessage({ type: "recycle", buffer: frame.buffer }, [frame.buffer]);
  };

  async function drain() {
    try {
      while (queue.length && !disposed && !failed) {
        const { frame, generation: frameGeneration } = queue.shift()!;
        if (resetPending) {
          resetPending = false;
          options.reset();
        }
        const samples = new Float32Array(frame.buffer);
        const output = await options.process(samples);
        if (disposed) return;
        if (frameGeneration !== generation || frame.sequence < streamStart + warmupFrames) {
          recycle(frame);
          continue;
        }
        samples.set(output);
        port.postMessage({ type: "processed", sequence: frame.sequence, buffer: frame.buffer }, [frame.buffer]);
      }
    } catch (error) {
      failed = true;
      queue.forEach(({ frame }) => recycle(frame));
      queue = [];
      options.onError(error);
    }
  }

  port.onmessage = (event: MessageEvent<FrameMessage>) => {
    const frame = event.data;
    if (frame.type !== "process" || disposed || failed) return;
    if (receivedSequence === undefined) streamStart = frame.sequence;
    else if (frame.sequence !== receivedSequence + 1) {
      generation += 1;
      streamStart = frame.sequence;
      resetPending = true;
      queue.forEach(({ frame: obsolete }) => recycle(obsolete));
      queue = [];
      port.postMessage({ type: "reset", sequence: streamStart });
    }
    receivedSequence = frame.sequence;
    queue.push({ frame, generation });
    processing ??= drain().finally(() => { processing = undefined; });
  };
  port.start();
  return {
    async dispose() {
      disposed = true;
      queue = [];
      port.onmessage = null;
      await processing;
    }
  };
}
