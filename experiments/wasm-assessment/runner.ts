/** Dependency-free host adapter for the assessment WASM ABI. It is intentionally not used by app code. */

export interface AssessmentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AssessmentVote {
  x0: number;
  y0: number;
  w: number;
  h: number;
  bits: Uint8Array;
  clean: Uint8Array;
}

export interface AssessmentNeighbour {
  image: Uint8Array;
  x: number;
  y: number;
  canvasId?: string;
  occlusions?: AssessmentRect[];
  voting?: AssessmentVote;
}

export interface ConsistencyInput {
  image: Uint8Array;
  labels: Uint8Array;
  width: number;
  height: number;
  region: AssessmentRect;
  code: number;
  pose: { x: number; y: number };
  canvasId?: string;
  prev?: AssessmentNeighbour;
  next?: AssessmentNeighbour;
  voting?: AssessmentVote;
  factor: number;
  noise: number;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  consistency_mask: (...args: number[]) => void;
  downscale_gray: (...args: number[]) => void;
}

export interface PreparedConsistency {
  /** Invoke the resident kernel without copying any input or output bytes. */
  call(): void;
  /** Copy the most recent output out of linear memory for parity tests. */
  readOutput(): Uint8Array;
  /** Replace only the current frame, modelling one new decoded frame. */
  copyCurrent(image: Uint8Array): void;
  /** Replace the current, previous, and next frames, modelling a full three-frame copy-in. */
  copyAll(current: Uint8Array, prev?: Uint8Array, next?: Uint8Array): void;
}

function align(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

function validFactor(factor: number): void {
  if (!Number.isInteger(factor) || factor < 1 || factor > 8192) throw new Error(`Invalid assessment factor ${factor}.`);
}

function validDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024
  ) {
    throw new Error('Dimensions exceed the bounded assessment ABI.');
  }
}

function validCoordinates(values: number[]): void {
  if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > 1_000_000)) {
    throw new Error('Coordinates exceed the bounded assessment ABI.');
  }
}

/** Linear-memory allocator used only to make pointer ownership explicit in tests and benchmarks. */
export class AssessmentWasm {
  readonly exports: WasmExports;
  private cursor: number;

  private constructor(readonly instance: WebAssembly.Instance) {
    this.exports = instance.exports as unknown as WasmExports;
    if (!this.exports.memory || !this.exports.__heap_base || !this.exports.consistency_mask || !this.exports.downscale_gray) {
      throw new Error('Assessment WASM exports are incomplete.');
    }
    this.cursor = Number(this.exports.__heap_base.value);
  }

  static async fromBytes(bytes: Uint8Array<ArrayBuffer>): Promise<AssessmentWasm> {
    return new AssessmentWasm((await WebAssembly.instantiate(bytes, {})).instance);
  }

  reset(): void {
    this.cursor = Number(this.exports.__heap_base.value);
  }

  alloc(size: number, alignment = 1): number {
    if (alignment < 1 || (alignment & alignment - 1) !== 0) throw new Error(`Invalid alignment ${alignment}.`);
    const pointer = align(this.cursor, alignment);
    const end = pointer + size;
    if (!Number.isSafeInteger(size) || size < 0 || end > 512 * 1024 * 1024) throw new Error('Assessment arena limit exceeded.');
    const requiredPages = Math.ceil(end / 65536);
    const currentPages = this.exports.memory.buffer.byteLength / 65536;
    if (requiredPages > currentPages) this.exports.memory.grow(requiredPages - currentPages);
    this.cursor = end;
    return pointer;
  }

  copyIn(bytes: Uint8Array, alignment = 1): number {
    const pointer = this.alloc(bytes.byteLength, alignment);
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
    return pointer;
  }

  private copyTo(pointer: number, bytes: Uint8Array): void {
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
  }

  private descriptor(vote: AssessmentVote | undefined): number {
    if (!vote) return 0;
    const bits = this.copyIn(vote.bits), clean = this.copyIn(vote.clean), pointer = this.alloc(32, 4);
    const view = new DataView(this.exports.memory.buffer, pointer, 32);
    view.setInt32(0, vote.x0, true);
    view.setInt32(4, vote.y0, true);
    view.setInt32(8, vote.w, true);
    view.setInt32(12, vote.h, true);
    view.setUint32(16, bits, true);
    view.setInt32(20, vote.bits.byteLength, true);
    view.setUint32(24, clean, true);
    view.setInt32(28, vote.clean.byteLength, true);
    return pointer;
  }

  private occlusions(rects: AssessmentRect[] | undefined): { pointer: number; count: number } {
    if (!rects?.length) return { pointer: 0, count: 0 };
    const pointer = this.alloc(rects.length * 32, 8), view = new DataView(this.exports.memory.buffer, pointer, rects.length * 32);
    rects.forEach((rect, index) => {
      const offset = index * 32;
      view.setFloat64(offset, rect.x, true);
      view.setFloat64(offset + 8, rect.y, true);
      view.setFloat64(offset + 16, rect.width, true);
      view.setFloat64(offset + 24, rect.height, true);
    });
    return { pointer, count: rects.length };
  }

  prepareConsistency(input: ConsistencyInput): PreparedConsistency {
    validDimensions(input.width, input.height);
    validCoordinates([input.pose.x, input.pose.y, input.region.x, input.region.y, input.region.width, input.region.height]);
    if (
      !Number.isInteger(input.code) || input.code < 0 || input.code > 255 || !Number.isFinite(input.noise) || input.noise < 0 ||
      input.noise > 255
    ) {
      throw new Error('Invalid assessment code/noise.');
    }
    if (input.image.byteLength !== input.width * input.height * 4) throw new Error('Current image size does not match width×height.');
    if (input.labels.byteLength !== input.width * input.height) throw new Error('Label size does not match width×height.');
    for (const neighbour of [input.prev, input.next]) {
      if (neighbour && neighbour.image.byteLength !== input.image.byteLength) throw new Error('Neighbour image size differs.');
      if (neighbour) {
        validCoordinates([neighbour.x, neighbour.y]);
        for (const rect of neighbour.occlusions ?? []) validCoordinates([rect.x, rect.y, rect.width, rect.height]);
      }
    }
    for (const vote of [input.voting, input.prev?.voting, input.next?.voting]) {
      if (vote) {
        validDimensions(vote.w, vote.h);
        validCoordinates([vote.x0, vote.y0]);
        if (!Number.isInteger(vote.x0) || !Number.isInteger(vote.y0)) throw new Error('Fractional vote origin.');
      }
      if (vote && (vote.bits.length < Math.ceil(vote.w * vote.h / 8) || vote.clean.length < Math.ceil(vote.w * vote.h / 8))) {
        throw new Error('Truncated vote bitset.');
      }
    }
    validFactor(input.factor);
    this.reset();

    const canvasId = input.canvasId ?? 'canvas';
    const sameCanvas = (neighbour: AssessmentNeighbour | undefined): boolean =>
      !!neighbour && (neighbour.canvasId === undefined || neighbour.canvasId === canvasId);
    const prevActive = sameCanvas(input.prev), nextActive = sameCanvas(input.next);
    const current = this.copyIn(input.image), labels = this.copyIn(input.labels), output = this.alloc(input.width * input.height);
    const prev = prevActive ? this.copyIn(input.prev!.image) : 0;
    const next = nextActive ? this.copyIn(input.next!.image) : 0;
    const prevOcclusions = this.occlusions(prevActive ? input.prev?.occlusions : undefined);
    const nextOcclusions = this.occlusions(nextActive ? input.next?.occlusions : undefined);
    const currentVote = this.descriptor(input.voting);
    const prevVote = this.descriptor(prevActive ? input.prev?.voting : undefined);
    const nextVote = this.descriptor(nextActive ? input.next?.voting : undefined);

    const call = (): void => {
      this.exports.consistency_mask(
        current,
        labels,
        prev,
        next,
        prevActive ? 1 : 0,
        nextActive ? 1 : 0,
        output,
        input.width,
        input.height,
        input.region.x,
        input.region.y,
        input.region.width,
        input.region.height,
        input.code,
        input.pose.x,
        input.pose.y,
        input.prev?.x ?? 0,
        input.prev?.y ?? 0,
        input.next?.x ?? 0,
        input.next?.y ?? 0,
        prevOcclusions.pointer,
        prevOcclusions.count,
        nextOcclusions.pointer,
        nextOcclusions.count,
        currentVote,
        prevVote,
        nextVote,
        input.factor,
        input.noise,
      );
    };

    return {
      call,
      readOutput: () => new Uint8Array(this.exports.memory.buffer, output, input.width * input.height).slice(),
      copyCurrent: (image) => {
        if (image.byteLength !== input.width * input.height * 4) throw new Error('Current image size does not match width×height.');
        this.copyTo(current, image);
      },
      copyAll: (newCurrent, newPrev, newNext) => {
        if (newCurrent.byteLength !== input.width * input.height * 4) throw new Error('Current image size does not match width×height.');
        this.copyTo(current, newCurrent);
        if (prevActive) {
          if (!newPrev || newPrev.byteLength !== input.width * input.height * 4) {
            throw new Error('Previous image size does not match width×height.');
          }
          this.copyTo(prev, newPrev);
        }
        if (nextActive) {
          if (!newNext || newNext.byteLength !== input.width * input.height * 4) {
            throw new Error('Next image size does not match width×height.');
          }
          this.copyTo(next, newNext);
        }
      },
    };
  }

  runConsistency(input: ConsistencyInput): Uint8Array {
    const prepared = this.prepareConsistency(input);
    prepared.call();
    return prepared.readOutput();
  }

  runDownscale(image: Uint8Array, width: number, height: number, factor: number): { width: number; height: number; data: Uint8Array } {
    validDimensions(width, height);
    if (image.byteLength !== width * height * 4) throw new Error('Image size does not match width×height.');
    validFactor(factor);
    this.reset();
    const outputWidth = Math.max(1, Math.ceil(width / factor)), outputHeight = Math.max(1, Math.ceil(height / factor));
    const input = this.copyIn(image), output = this.alloc(outputWidth * outputHeight);
    this.exports.downscale_gray(input, output, width, height, factor);
    return {
      width: outputWidth,
      height: outputHeight,
      data: new Uint8Array(this.exports.memory.buffer, output, outputWidth * outputHeight).slice(),
    };
  }
}
