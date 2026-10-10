export interface EncodedFrame { data: Uint8Array; isKeyframe: boolean; ptsUs: number; width: number; height: number }
const HEADER = 28;
const CHUNK = 16 * 1024;
const MAX_FRAME = 16 * 1024 * 1024;
const MAGIC = 0x4b525631;

export function fragmentFrame(frame: EncodedFrame, frameId: number): ArrayBuffer[] {
  if (!frame.data.length || frame.data.length > MAX_FRAME) throw new Error('Invalid frame size');
  const count = Math.ceil(frame.data.length / CHUNK);
  return Array.from({ length: count }, (_, index) => {
    const data = frame.data.subarray(index * CHUNK, (index + 1) * CHUNK);
    const packet = new ArrayBuffer(HEADER + data.length);
    const header = new DataView(packet);
    header.setUint32(0, MAGIC); header.setUint32(4, frameId);
    header.setUint16(8, index); header.setUint16(10, count);
    header.setFloat64(12, frame.ptsUs); header.setUint16(20, frame.width); header.setUint16(22, frame.height);
    header.setUint8(24, frame.isKeyframe ? 1 : 0);
    new Uint8Array(packet, HEADER).set(data);
    return packet;
  });
}

export class FrameAssembler {
  private pending = new Map<number, { chunks: Map<number, Uint8Array>; count: number; size: number; frame: Omit<EncodedFrame, 'data'> }>();
  push(packet: ArrayBuffer): EncodedFrame | null {
    if (packet.byteLength <= HEADER || packet.byteLength > HEADER + CHUNK) throw new Error('Invalid frame packet');
    const header = new DataView(packet);
    const id = header.getUint32(4), index = header.getUint16(8), count = header.getUint16(10);
    const width = header.getUint16(20), height = header.getUint16(22), ptsUs = header.getFloat64(12);
    if (header.getUint32(0) !== MAGIC || !count || count > MAX_FRAME / CHUNK || index >= count ||
        !width || !height || width > 8192 || height > 8192 || !Number.isFinite(ptsUs)) throw new Error('Invalid frame header');
    if (!this.pending.has(id)) {
      if (this.pending.size >= 4) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(id, { chunks: new Map(), count, size: 0, frame: { width, height, ptsUs, isKeyframe: !!header.getUint8(24) } });
    }
    const entry = this.pending.get(id)!;
    if (entry.count !== count || entry.frame.width !== width || entry.frame.height !== height || entry.frame.ptsUs !== ptsUs) throw new Error('Inconsistent frame packets');
    if (!entry.chunks.has(index)) { const data = new Uint8Array(packet, HEADER); entry.chunks.set(index, data); entry.size += data.length; }
    if (entry.size > MAX_FRAME) { this.pending.delete(id); throw new Error('Frame exceeds limit'); }
    if (entry.chunks.size !== count) return null;
    const data = new Uint8Array(entry.size); let offset = 0;
    for (let i = 0; i < count; i++) { const part = entry.chunks.get(i)!; data.set(part, offset); offset += part.length; }
    this.pending.delete(id);
    return { ...entry.frame, data };
  }
  clear() { this.pending.clear(); }
}
