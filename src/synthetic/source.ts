import type { FrameImage, FrameSource, MediaInfo } from '../types.ts';
import { renderFrame, type Scenario } from './world.ts';
/** FrameSource over a synthetic scenario. Lossless pixels, exact timing, identical in Deno and in the browser. */
export class ScenarioSource implements FrameSource {
  info: MediaInfo;
  private stopped = false;
  constructor(readonly scenario: Scenario) {
    const last = scenario.frames[scenario.frames.length - 1];
    this.info = {
      name: `demo-${scenario.name}.generated`,
      size: 0,
      width: scenario.width,
      height: scenario.height,
      codedWidth: scenario.width,
      codedHeight: scenario.height,
      rotation: 0,
      duration: last.time + last.duration,
      frameCount: scenario.frames.length,
      codec: 'procedural / lossless pixels',
      mode: 'Deterministic test input',
      noise: 0,
      warnings: ['This is synthetic test material, not evidence of accuracy on arbitrary real recordings.'],
      notices: [],
    };
  }
  dispose(): void {
    this.stopped = true;
  }
  async *frames(): AsyncGenerator<FrameImage> {
    for (let index = 0; index < this.scenario.frames.length && !this.stopped; index++) {
      const f = this.scenario.frames[index];
      yield { image: renderFrame(this.scenario, index).image, time: f.time, duration: f.duration, index };
      await Promise.resolve();
    }
  }
}
