export class FileSender {
  private pending: { resolve: (message: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private busy = false;
  constructor(private channel: RTCDataChannel) {}
  onMessage(message: any): boolean {
    if (!['ready', 'ack', 'error'].includes(message.action) || !this.pending) return false;
    const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
    if (message.action === 'error') pending.reject(new Error(message.message || 'Transfer rejected'));
    else pending.resolve(message);
    return true;
  }
  private exchange(message: object): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.channel.readyState !== 'open') { reject(new Error('File channel is disconnected.')); return; }
      const timer = setTimeout(() => { this.pending = null; reject(new Error('File transfer timed out.')); }, 30_000);
      this.pending = { resolve, reject, timer };
      try { this.channel.send(JSON.stringify(message)); }
      catch (error) { clearTimeout(timer); this.pending = null; reject(error); }
    });
  }
  async send(file: File, progress: (percent: number) => void) {
    if (this.busy) throw new Error('A transfer is already in progress.');
    if (file.size > 100 * 1024 * 1024) throw new Error('Browser transfers are limited to 100 MB.');
    this.busy = true;
    const transferId = crypto.randomUUID();
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const checksum = Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
      const chunkSize = 8192, count = Math.max(1, Math.ceil(file.size / chunkSize));
      const ready = await this.exchange({ action: 'metadata', metadata: { transfer_id: transferId, filename: file.name,
        file_size_bytes: file.size, chunk_size: chunkSize, total_chunks: count, sha256_checksum: checksum } });
      if (ready.transferId !== transferId) throw new Error('Invalid transfer acknowledgment');
      for (let index = 0; index < count; index++) {
        const data = Array.from(new Uint8Array(await file.slice(index * chunkSize, (index + 1) * chunkSize).arrayBuffer()));
        const reply = await this.exchange({ action: 'chunk', chunk: { transfer_id: transferId, chunk_index: index, total_chunks: count, data } });
        if (reply.ack?.transfer_id !== transferId || reply.ack.chunk_index !== index) throw new Error('Invalid chunk acknowledgment');
        if (index === count - 1 && reply.ack.state !== 'Completed') throw new Error('Host verification is incomplete.');
        progress(Math.round((index + 1) / count * 100));
      }
    } catch (error) {
      if (this.channel.readyState === 'open') this.channel.send(JSON.stringify({ action: 'cancel', transferId }));
      throw error;
    } finally { this.busy = false; }
  }
  close() {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Transfer disconnected')); this.pending = null; }
  }
}

export class FileReceiver {
  private transfers = new Map<string, { metadata: any; chunks: Map<number, Uint8Array>; bytes: number }>();
  constructor(private channel: RTCDataChannel, private completed: (name: string, blob: Blob) => void) {}
  async onMessage(message: any) {
    if (message.action === 'metadata') {
      const m = message.metadata;
      if (!m || !/^[a-f0-9-]{36}$/.test(m.transfer_id) || typeof m.filename !== 'string' || /[\\/\x00-\x1f]/.test(m.filename) ||
        m.filename.length < 1 || m.filename.length > 255 || !Number.isSafeInteger(m.file_size_bytes) || m.file_size_bytes < 0 || m.file_size_bytes > 100 * 1024 * 1024 ||
        m.chunk_size !== 8192 || m.total_chunks !== Math.max(1, Math.ceil(m.file_size_bytes / m.chunk_size)) || !/^[a-f0-9]{64}$/i.test(m.sha256_checksum) ||
        this.transfers.size >= 1 || this.transfers.has(m.transfer_id)) throw new Error('Invalid file metadata or transfer limit exceeded.');
      this.transfers.set(m.transfer_id, { metadata: m, chunks: new Map(), bytes: 0 });
      this.channel.send(JSON.stringify({ action: 'ready', transferId: m.transfer_id }));
    } else if (message.action === 'chunk') {
      const c = message.chunk, transfer = this.transfers.get(c?.transfer_id);
      if (!transfer || !Number.isInteger(c.chunk_index) || c.chunk_index < 0 || c.chunk_index >= transfer.metadata.total_chunks ||
        c.total_chunks !== transfer.metadata.total_chunks || !Array.isArray(c.data) ||
        c.data.length !== Math.min(8192, transfer.metadata.file_size_bytes - c.chunk_index * 8192) ||
        !c.data.every((v: number) => Number.isInteger(v) && v >= 0 && v <= 255)) throw new Error('Invalid file chunk');
      if (!transfer.chunks.has(c.chunk_index)) { transfer.chunks.set(c.chunk_index, new Uint8Array(c.data)); transfer.bytes += c.data.length; }
      let state = 'Transferring';
      if (transfer.chunks.size === transfer.metadata.total_chunks) {
        const bytes = new Uint8Array(transfer.metadata.file_size_bytes);
        for (let i = 0; i < transfer.metadata.total_chunks; i++) bytes.set(transfer.chunks.get(i)!, i * 8192);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
        this.transfers.delete(c.transfer_id);
        if (hash !== transfer.metadata.sha256_checksum.toLowerCase()) throw new Error('File checksum mismatch');
        this.completed(transfer.metadata.filename, new Blob([bytes])); state = 'Completed';
      }
      this.channel.send(JSON.stringify({ action: 'ack', ack: { transfer_id: c.transfer_id, chunk_index: c.chunk_index, received_bytes: transfer.bytes, state } }));
    } else if (message.action === 'cancel') this.transfers.delete(message.transferId);
  }
  clear() { this.transfers.clear(); }
}
