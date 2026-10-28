const PIPELINE_DELAY_FRAMES = 3;
const POOL_SIZE = 12;
const CROSSFADE_SAMPLES = 960;
const TRANSITION_SAMPLES = 240; // 5 ms at the chain's 48 kHz sample rate.

class DeepFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { frameLength, latencySamples } = options.processorOptions;
    if (!Number.isInteger(frameLength) || frameLength <= 0 || !Number.isInteger(latencySamples) || latencySamples < 0) throw new Error("Invalid noise suppression timing");
    this.workerPort = undefined;
    this.ready = false;
    this.failed = false;
    this.frameLength = frameLength;
    this.latencySamples = latencySamples;
    this.rawDelay = new Float32Array(latencySamples);
    this.rawDelayOffset = 0;
    this.frameOffset = 0;
    this.sequence = 0;
    this.lastSentSequence = undefined;
    this.minimumProcessedSequence = 0;
    this.currentInput = new Float32Array(frameLength);
    this.currentRaw = new Float32Array(frameLength);
    this.rawPool = Array.from({ length: POOL_SIZE }, () => new Float32Array(frameLength));
    this.processPool = Array.from({ length: POOL_SIZE }, () => new ArrayBuffer(frameLength * Float32Array.BYTES_PER_ELEMENT));
    this.rawFrames = new Map();
    this.processedFrames = new Map();
    this.outputFrame = undefined;
    this.outputRaw = undefined;
    this.outputOffset = 0;
    this.outputProcessed = false;
    this.lastResidual = 0;
    this.transitionFrom = 0;
    this.transitionPosition = TRANSITION_SAMPLES;
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

  invalidateProcessed(sequence) {
    this.minimumProcessedSequence = Math.max(this.minimumProcessedSequence, sequence + Math.ceil(this.latencySamples / this.frameLength));
    for (const [key, frame] of this.processedFrames) {
      if (key >= this.minimumProcessedSequence) continue;
      this.processPool.push(frame.buffer);
      this.processedFrames.delete(key);
    }
  }

  handleWorkerMessage(message) {
    if (message.type === "ready") {
      if (message.frameLength !== this.frameLength) {
        this.failed = true;
        this.port.postMessage({ type: "error", message: `Unexpected noise suppression frame length: ${message.frameLength}` });
        return;
      }
      this.ready = true;
      this.failed = false;
      return;
    }
    if (message.type === "reset") {
      this.invalidateProcessed(message.sequence);
      return;
    }
    if (message.type === "error") {
      this.failed = true;
      this.ready = true;
      this.port.postMessage(message);
      return;
    }
    if (message.type === "recycle") {
      this.processPool.push(message.buffer);
      return;
    }
    if (message.type !== "processed") return;
    if (message.sequence < this.minimumProcessedSequence || message.sequence < this.sequence - PIPELINE_DELAY_FRAMES || this.failed) {
      this.processPool.push(message.buffer);
      return;
    }
    this.processedFrames.set(message.sequence, new Float32Array(message.buffer));
  }

  finishInputFrame() {
    const sequence = this.sequence++;
    this.rawFrames.set(sequence, this.currentRaw);
    this.currentRaw = this.rawPool.pop() ?? new Float32Array(this.frameLength);

    const processBuffer = this.processPool.pop();
    if (this.ready && !this.failed && processBuffer && this.workerPort) {
      if (this.lastSentSequence !== sequence - 1) this.invalidateProcessed(sequence);
      this.lastSentSequence = sequence;
      new Float32Array(processBuffer).set(this.currentInput);
      this.workerPort.postMessage({ type: "process", sequence, buffer: processBuffer }, [processBuffer]);
    } else if (processBuffer) {
      this.processPool.push(processBuffer);
    }

    if (!this.ready) {
      if (sequence >= PIPELINE_DELAY_FRAMES) {
        const expiredSequence = sequence - PIPELINE_DELAY_FRAMES;
        const expiredRaw = this.rawFrames.get(expiredSequence);
        this.rawFrames.delete(expiredSequence);
        if (expiredRaw) this.rawPool.push(expiredRaw);
      }
      return;
    }
    if (sequence < PIPELINE_DELAY_FRAMES) return;
    const outputSequence = sequence - PIPELINE_DELAY_FRAMES;
    const fallback = this.rawFrames.get(outputSequence);
    if (!fallback) return;
    this.rawFrames.delete(outputSequence);
    let processed = this.processedFrames.get(outputSequence);
    this.processedFrames.delete(outputSequence);
    if (processed && (this.failed || outputSequence < this.minimumProcessedSequence)) {
      this.processPool.push(processed.buffer);
      processed = undefined;
    }
    const useProcessed = !!processed;
    if (useProcessed !== this.outputProcessed) {
      // Future enhanced samples don't exist on an underrun. Fade its last
      // residual against the continuously aligned raw signal instead of jumping
      // to a different instant, holding a waveform, or replaying an older frame.
      this.transitionFrom = this.lastResidual;
      this.transitionPosition = 0;
      this.outputProcessed = useProcessed;
    }
    this.outputFrame = processed;
    this.outputRaw = fallback;
    this.outputOffset = 0;
    if (useProcessed) {
      if (this.consecutiveFallbacks >= 20) this.port.postMessage({ type: "recovered" });
      this.consecutiveFallbacks = 0;
    } else {
      this.consecutiveFallbacks += 1;
      if (this.consecutiveFallbacks === 20) this.port.postMessage({ type: "underrun" });
    }
    if (!this.delayedOutputStarted) {
      this.delayedOutputStarted = true;
      this.crossfadeRemaining = CROSSFADE_SAMPLES;
    }
  }

  releaseOutputFrame() {
    if (this.outputFrame) this.processPool.push(this.outputFrame.buffer);
    if (this.outputRaw) this.rawPool.push(this.outputRaw);
    this.outputFrame = undefined;
    this.outputRaw = undefined;
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
      let alignedRaw = rawSample;
      if (this.rawDelay.length) {
        alignedRaw = this.rawDelay[this.rawDelayOffset];
        this.rawDelay[this.rawDelayOffset] = rawSample;
        this.rawDelayOffset = (this.rawDelayOffset + 1) % this.rawDelay.length;
      }
      let nextSample = rawSample;
      if (this.ready && this.delayedOutputStarted && this.outputRaw) {
        const dry = this.outputRaw[this.outputOffset];
        const residual = this.outputFrame ? this.outputFrame[this.outputOffset] - dry : 0;
        let blended = residual;
        if (this.transitionPosition < TRANSITION_SAMPLES) {
          // Complementary sine-squared weights avoid a boost for correlated dry/wet.
          const mix = Math.sin(Math.PI / 2 * this.transitionPosition / TRANSITION_SAMPLES) ** 2;
          blended = this.transitionFrom * (1 - mix) + residual * mix;
          this.transitionPosition += 1;
        }
        this.lastResidual = blended;
        nextSample = dry + blended;
        this.outputOffset += 1;
        if (this.crossfadeRemaining > 0) {
          const mix = 1 - this.crossfadeRemaining / CROSSFADE_SAMPLES;
          nextSample = rawSample * (1 - mix) + nextSample * mix;
          this.crossfadeRemaining -= 1;
        }
        if (this.outputOffset === this.frameLength) this.releaseOutputFrame();
      }
      output[index] = nextSample;
      this.currentInput[this.frameOffset] = rawSample;
      this.currentRaw[this.frameOffset] = alignedRaw;
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
