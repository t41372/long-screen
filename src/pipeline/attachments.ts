// Shell: plain bookkeeping over the fragment-attachment chain solve() builds and render() walks. Not an
// algorithm awaiting a Rust port — it is graph-shaped storage lookup, not a numerical decision.
import type { Attachment, Point } from '../types.ts';
import type { PoseGraph } from '../core/pose-graph.ts';
/** Follows a fragment's attachment chain to the canvas it finally resolves to (a fragment attached onto another
 * fragment that was itself later attached, etc). Shared by solve()'s canonicalCanvas/canonical and render()'s
 * resolvePlacement, which both walk the same `attach/<id>` chain. */
export function resolveTarget(attachments: Map<string, Attachment>, id: string): string {
  const seen = new Set<string>();
  while (attachments.has(id) && !seen.has(id)) {
    seen.add(id);
    id = attachments.get(id)!.target;
  }
  return id;
}
/** Total rigid shift from a canvas through its attachment chain to the canvas it finally resolves to. */
export function attachmentShift(attachments: Map<string, Attachment>, id: string): Point {
  const shift = { x: 0, y: 0 }, seen = new Set<string>();
  while (attachments.has(id) && !seen.has(id)) {
    seen.add(id);
    const a = attachments.get(id)!;
    shift.x += a.dx;
    shift.y += a.dy;
    id = a.target;
  }
  return shift;
}
/** Render-time variant of attachmentShift: a fragment's dx/dy was measured once, against the target keyframe node it
 * matched at attach time. If that node has since moved under graph optimization (its own canvas absorbed a later
 * loop closure), the frozen dx/dy alone would leave the attached fragment's pixels behind. Add how much that anchor
 * node has moved (as of the attach frame) on top of the fixed offset; this does not double count against the A2
 * odometry/loop edge, which only governs the chain of nodes minted after the attachment. */
export async function attachedRenderShift(attachments: Map<string, Attachment>, graph: PoseGraph, id: string): Promise<Point> {
  const shift = { x: 0, y: 0 }, seen = new Set<string>();
  while (attachments.has(id) && !seen.has(id)) {
    seen.add(id);
    const a = attachments.get(id)!;
    const c = await graph.correction(a.node, a.frame);
    shift.x += a.dx + c.x;
    shift.y += a.dy + c.y;
    id = a.target;
  }
  return shift;
}
