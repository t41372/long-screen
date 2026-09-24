/** Adapter for the Rust reconstruction core (`rust/core`, compiled to `assets/core.wasm`).
 *
 *  This is the only place TypeScript touches Wasm linear memory. Every kernel call follows one shape:
 *  reserve arena space, copy inputs in, call, copy outputs out, leave the arena for the next call to replan.
 *  The arena is a bump allocator on top of `ls_alloc`, grown in large chunks so per-frame calls never allocate
 *  in Rust; it is never freed mid-run, only replaced (grown) when a call needs more than it currently holds.
 *  Kernels return negative status codes rather than trapping; those are surfaced as thrown errors.
 *
 *  Split by domain under `src/core/wasm/`, mirroring `rust/core/src/abi/*.rs`; this file is a barrel that
 *  re-exports every name callers already import from `src/core/wasm.ts` (16 importers, including
 *  `tests/support/core.ts`, which needs `loadCore`/`simdSupported`). */
export type { AuditResult, CoreThreads, LabelMask, PatchInput, RefinementResult } from './wasm/core.ts';
export { Core } from './wasm/core.ts';
export type { LearnerAccumulators } from './wasm/learner.ts';
export { LearnerHandle } from './wasm/learner.ts';
export type { BytesInput, FrameInput } from './wasm/memory.ts';
export { FrameRing, Resident, ResidentFrame, ResidentGray } from './wasm/memory.ts';
export type { VotingBox, VotingRecord, VotingVerdict } from './wasm/voting.ts';
export { VotingRing } from './wasm/voting.ts';
export type { FinishAccumulators } from './wasm/regions.ts';
export type { PoseGraphEdges, PoseGraphNodes } from './wasm/pose-graph.ts';
export type {
  EvaluateCandidatesKeyframe,
  EvaluateCandidatesQuery,
  EvaluateCandidatesResult,
  FragmentCauseGate,
  LoopVerdict,
  OcclusionDecision,
} from './wasm/track.ts';
export type { FrameLayout, FramingSession, FramingTile, SourceFramingTile } from './wasm/framing.ts';
export type { CompositeObservation, CompositeTile, CompositeTileStats, PreparedObservation } from './wasm/composite.ts';
export type {
  OverwriteStats,
  OverwriteTile,
  TemporalCommitResult,
  TemporalComponent,
  TemporalIndexHandle,
  TemporalMaskInput,
  TemporalRow,
} from './wasm/temporal.ts';
export type { ConsistencyMaskInput, ConsistencyNeighbourInput, ConsistencyVoteInput } from './wasm/consistency.ts';
export { core, coreBuild, coreLoaded, type CorePlan, loadCore, loadPlannedCore, planCore, simdSupported } from './wasm/loader.ts';
