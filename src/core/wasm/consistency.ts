/** World-consistency masking (mirrors `rust/core/src/abi/consistency.rs`). */
import type { Rect } from '../../types.ts';
import type { Core } from './core.ts';
import { type BytesInput, type FrameInput, Resident, ResidentFrame } from './memory.ts';

export interface ConsistencyVoteInput {
  x0: number;
  y0: number;
  w: number;
  h: number;
  bits: Uint8Array;
  clean: Uint8Array;
  screen?: Uint8Array;
}
export interface ConsistencyNeighbourInput {
  image: FrameInput;
  x: number;
  y: number;
  occlusions?: Rect[];
  voting?: ConsistencyVoteInput;
}
export interface ConsistencyMaskInput {
  image: FrameInput;
  labels: BytesInput;
  region: Rect;
  code: number;
  pose: { x: number; y: number };
  prev?: ConsistencyNeighbourInput;
  next?: ConsistencyNeighbourInput;
  voting?: ConsistencyVoteInput;
  factor: number;
  noise: number;
}

export function consistencyMask(core: Core, input: ConsistencyMaskInput): Uint8Array<ArrayBuffer> {
  const { width, height } = input.image;
  const output = runConsistencyMask(core, input);
  return core.readBytes(output, width * height);
}
/** Same kernel, written into a resident buffer so the compositor can consume it without a round trip. */
export function consistencyMaskInto(core: Core, input: ConsistencyMaskInput, output: Resident): void {
  if (output.length !== input.image.width * input.image.height) {
    throw new Error('CORE_BAD_ARGUMENT: mask buffer does not match the frame.');
  }
  runConsistencyMask(core, input, output);
}
/** Plans arena space in one shot for every JS-side input (resident inputs stay in place) plus a transient output
 *  when no resident one is given, and runs the kernel. Returns the output pointer. */
function runConsistencyMask(core: Core, input: ConsistencyMaskInput, resident?: Resident): number {
  const { width, height } = input.image, pixels = width * height;
  const voteBytes = (v?: ConsistencyVoteInput) => v ? Math.ceil(v.w * v.h / 8) : 0;
  const residentImage = input.image instanceof ResidentFrame, residentLabels = input.labels instanceof Resident;
  const neighbourSizes = (n?: ConsistencyNeighbourInput) =>
    n
      ? [
        n.image instanceof ResidentFrame ? 0 : pixels * 4,
        48,
        (n.occlusions?.length || 0) * 32,
        32,
        voteBytes(n.voting),
        voteBytes(n.voting),
        voteBytes(n.voting),
      ]
      : [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ];
  const ptr = core.scratch([
    residentImage ? 0 : pixels * 4,
    residentLabels ? 0 : pixels,
    32,
    32,
    voteBytes(input.voting),
    voteBytes(input.voting),
    voteBytes(input.voting),
    ...neighbourSizes(input.prev),
    ...neighbourSizes(input.next),
    resident ? 0 : pixels,
  ]);
  const [rgbaScratch, labelsScratch, region, voteDesc, voteBits, voteClean, voteScreen] = ptr,
    output = resident ? resident.ptr : ptr[ptr.length - 1];
  const rgba = core.placeFrame(input.image, rgbaScratch);
  let labels: number;
  if (input.labels instanceof Resident) {
    if (input.labels.length !== pixels) throw new Error('CORE_BAD_ARGUMENT: resident labels do not match the frame.');
    labels = input.labels.ptr;
  } else {
    labels = labelsScratch;
    core.writeBytes(labels, input.labels);
  }
  core.writeRect(region, input.region);
  const writeVote = (desc: number, bits: number, clean: number, screen: number, v?: ConsistencyVoteInput): number => {
    if (!v) return 0;
    const bytes = voteBytes(v);
    if (v.bits.length < bytes || v.clean.length < bytes) throw new Error('CORE_BAD_ARGUMENT: truncated consistency vote bitset.');
    core.writeBytes(bits, v.bits.subarray(0, bytes));
    core.writeBytes(clean, v.clean.subarray(0, bytes));
    const view = new DataView(core.exports.memory.buffer, desc, 32);
    view.setInt32(0, v.x0, true);
    view.setInt32(4, v.y0, true);
    view.setInt32(8, v.w, true);
    view.setInt32(12, v.h, true);
    view.setUint32(16, bits, true);
    view.setUint32(20, clean, true);
    if (v.screen && v.screen.length < bytes) throw new Error('CORE_BAD_ARGUMENT: truncated screen witness bitset.');
    if (v.screen) core.writeBytes(screen, v.screen.subarray(0, bytes));
    view.setUint32(24, v.screen ? screen : 0, true);
    return desc;
  };
  const vote = writeVote(voteDesc, voteBits, voteClean, voteScreen, input.voting);
  const writeNeighbour = (offset: number, n?: ConsistencyNeighbourInput): number => {
    if (!n) return 0;
    const [imageScratch, desc, occlusions, nVoteDesc, nBits, nClean, nScreen] = ptr.slice(offset, offset + 7);
    if (n.image.width !== width || n.image.height !== height) throw new Error('CORE_BAD_ARGUMENT: neighbour frame size differs.');
    const image = core.placeFrame(n.image, imageScratch);
    (n.occlusions || []).forEach((r, i) => core.writeRect(occlusions + i * 32, r));
    const view = new DataView(core.exports.memory.buffer, desc, 48);
    view.setUint32(0, image, true);
    view.setFloat64(8, n.x, true);
    view.setFloat64(16, n.y, true);
    view.setUint32(24, n.occlusions?.length ? occlusions : 0, true);
    view.setUint32(28, n.occlusions?.length || 0, true);
    view.setUint32(32, writeVote(nVoteDesc, nBits, nClean, nScreen, n.voting), true);
    return desc;
  };
  const prev = writeNeighbour(7, input.prev), next = writeNeighbour(14, input.next);
  core.check(
    core.exports.ls_consistency_mask(
      rgba,
      labels,
      width,
      height,
      region,
      input.code,
      input.pose.x,
      input.pose.y,
      prev,
      next,
      vote,
      input.factor,
      input.noise,
      output,
    ),
    'consistencyMask',
  );
  return output;
}
