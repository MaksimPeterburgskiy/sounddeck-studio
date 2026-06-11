export function makeWaveform(buffer: AudioBuffer, buckets = 48) {
  const data = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / buckets));
  const peaks: number[] = [];
  for (let i = 0; i < buckets; i += 1) {
    let sum = 0;
    const start = i * block;
    for (let j = 0; j < block && start + j < data.length; j += 1) {
      sum += Math.abs(data[start + j]);
    }
    peaks.push(Math.min(1, Math.sqrt(sum / block) * 2.4));
  }
  return peaks;
}
