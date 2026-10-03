/**
 * Fixed-size slot blocks for an InstancedMesh: each tile owns one block
 * per primitive kind, allocated on first build and recycled on removal.
 * `highWater` is one past the highest block in use, so a mesh draws
 * `highWater × blockSize` instances and never more than it needs.
 */
export class BlockAllocator {
  private readonly used: Uint8Array;
  private readonly free: number[] = [];
  private next = 0;
  private top = 0;

  constructor(readonly capacity: number) {
    this.used = new Uint8Array(capacity);
  }

  get highWater(): number {
    return this.top;
  }

  get live(): number {
    return this.next - this.free.length;
  }

  alloc(): number {
    let block: number;
    if (this.free.length > 0) {
      block = this.free.pop()!;
    } else {
      if (this.next >= this.capacity) {
        throw new Error(`BlockAllocator: capacity ${this.capacity} exhausted`);
      }
      block = this.next++;
    }
    this.used[block] = 1;
    if (block + 1 > this.top) this.top = block + 1;
    return block;
  }

  release(block: number): void {
    if (block < 0 || block >= this.capacity || !this.used[block]) return;
    this.used[block] = 0;
    this.free.push(block);
    while (this.top > 0 && !this.used[this.top - 1]) this.top--;
  }
}
