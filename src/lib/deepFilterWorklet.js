const PIPELINE_DELAY_FRAMES = 3;
const POOL_SIZE = 12;
const CROSSFADE_SAMPLES = 960;

class DeepFilterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.workerPort = undefined;
    this.ready = false;
    this.failed = false;
    this.frameLength = 480;
    this.frameOffset = 0;
    this.sequence = 0;
    this.currentRaw = new Float32Array(this.frameLength);
    this.rawPool = Array.from({ length: POOL_SIZE }, () => new Float32Array(this.frameLength));
    this.processPool = Array.from({ length: POOL_SIZE }, () => new ArrayBuffer(this.frameLength * Float32Array.BYTES_PER_ELEMENT));
    this.rawFrames = new Map();
    this.processedFrames = new Map();
    this.outputFrame = undefined;
    this.outputFrameKind = "raw";
    this.outputOffset = 0;
    this.delayedOutputStarted = false;
    this.crossfadeRemaining = 0;
    this.consecutiveFallbacks = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "connect") return;
      this.workerPort = event.data.port;
      this.workerPort.onmessage = (workerEvent) => this.handleWorkerMessage(workerEvent.data);
      this.workerPort.start();
    };
  }

  handleWorkerMessage(message) {
    if (message.type === "ready") {
      if (message.frameLength !== this.frameLength) {
        this.failed = true;
        this.port.postMessage({ type: "error", message: `Unexpected DeepFilterNet frame length: ${message.frameLength}` });
        return;
      }
      this.ready = true;
      this.failed = false;
      return;
    }
    if (message.type === "error") {
      this.failed = true;
      // Keep the delayed pipeline running so fallback audio stays time-aligned.
      this.ready = true;
      this.port.postMessage(message);
      return;
    }
    const frame = new Float32Array(message.buffer);
    if (message.sequence < this.sequence - PIPELINE_DELAY_FRAMES) {
      this.processPool.push(message.buffer);
      return;
    }
    this.processedFrames.set(message.sequence, frame);
  }

  finishInputFrame() {
    const sequence = this.sequence;
    this.sequence += 1;
    const rawFrame = this.currentRaw;
    this.rawFrames.set(sequence, rawFrame);
    this.currentRaw = this.rawPool.pop() ?? new Float32Array(this.frameLength);

    const processBuffer = this.processPool.pop();
    if (this.ready && !this.failed && processBuffer && this.workerPort) {
      new Float32Array(processBuffer).set(rawFrame);
      this.workerPort.postMessage({ type: "process", sequence, buffer: processBuffer }, [processBuffer]);
    } else if (processBuffer) {
      this.processPool.push(processBuffer);
    }

    if (!this.ready) {
      if (sequence >= PIPELINE_DELAY_FRAMES) {
        const expiredRaw = this.rawFrames.get(sequence - PIPELINE_DELAY_FRAMES);
        this.rawFrames.delete(sequence - PIPELINE_DELAY_FRAMES);
        if (expiredRaw) this.rawPool.push(expiredRaw);
      }
      return;
    }
    if (sequence < PIPELINE_DELAY_FRAMES) return;
    const outputSequence = sequence - PIPELINE_DELAY_FRAMES;
    const fallback = this.rawFrames.get(outputSequence);
    if (!fallback) return;
    this.rawFrames.delete(outputSequence);
    const processed = this.processedFrames.get(outputSequence);
    this.processedFrames.delete(outputSequence);
    if (processed) {
      const recovered = this.consecutiveFallbacks >= 20 && !this.failed;
      this.outputFrame = processed;
      this.outputFrameKind = "processed";
      this.rawPool.push(fallback);
      this.consecutiveFallbacks = 0;
      if (recovered) this.port.postMessage({ type: "recovered" });
    } else {
      this.outputFrame = fallback;
      this.outputFrameKind = "raw";
      this.consecutiveFallbacks += 1;
      if (this.consecutiveFallbacks === 20) this.port.postMessage({ type: "underrun" });
    }
    this.outputOffset = 0;
    if (!this.delayedOutputStarted) {
      this.delayedOutputStarted = true;
      this.crossfadeRemaining = CROSSFADE_SAMPLES;
    }
  }

  releaseOutputFrame() {
    if (!this.outputFrame) return;
    if (this.outputFrameKind === "processed") this.processPool.push(this.outputFrame.buffer);
    else this.rawPool.push(this.outputFrame);
    this.outputFrame = undefined;
    this.outputOffset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }

    for (let index = 0; index < output.length; index += 1) {
      const rawSample = input[index] ?? 0;
      let nextSample = rawSample;
      if (this.ready && this.delayedOutputStarted && this.outputFrame) {
        const delayedSample = this.outputFrame[this.outputOffset] ?? 0;
        this.outputOffset += 1;
        if (this.crossfadeRemaining > 0) {
          const processedMix = 1 - this.crossfadeRemaining / CROSSFADE_SAMPLES;
          nextSample = rawSample * (1 - processedMix) + delayedSample * processedMix;
          this.crossfadeRemaining -= 1;
        } else {
          nextSample = delayedSample;
        }
        if (this.outputOffset === this.frameLength) this.releaseOutputFrame();
      }
      output[index] = nextSample;

      this.currentRaw[this.frameOffset] = rawSample;
      this.frameOffset += 1;
      if (this.frameOffset === this.frameLength) {
        this.frameOffset = 0;
        this.finishInputFrame();
      }
    }
    return true;
  }
}

registerProcessor("sounddeck-deep-filter", DeepFilterProcessor);
