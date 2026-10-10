import { describe, it, expect } from 'vitest';
import { fragmentFrame, FrameAssembler } from '../src/video';

describe('Native video delivery', () => {
  it('reassembles large frames out of order, including duplicate fragments', () => {
    const data = Uint8Array.from({ length: 150_000 }, (_, i) => i % 256);
    const frame = { data, isKeyframe: true, width: 1920, height: 1080, ptsUs: 42_000 };
    const packets = fragmentFrame(frame, 5);
    const receiver = new FrameAssembler();
    expect(receiver.push(packets[2]!)).toBeNull(); expect(receiver.push(packets[2]!)).toBeNull();
    let assembled = null;
    for (const packet of packets.reverse()) { const result = receiver.push(packet); if (result) assembled = result; }
    expect(assembled).toEqual(frame);
    expect(packets.every(packet => packet.byteLength <= 16412)).toBe(true);
  });
  it('rejects malformed and inconsistent headers', () => {
    const packets = fragmentFrame({ data: new Uint8Array(40_000), isKeyframe: false, width: 640, height: 480, ptsUs: 0 }, 2);
    const receiver = new FrameAssembler(); receiver.push(packets[0]!);
    new DataView(packets[1]!).setUint16(20, 800);
    expect(() => receiver.push(packets[1]!)).toThrow('Inconsistent');
    expect(() => receiver.push(new ArrayBuffer(8))).toThrow('Invalid');
  });
});
