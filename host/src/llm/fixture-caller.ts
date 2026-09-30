import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { UserError } from "../workspace.ts";
import type {
  ModelCaller,
  ModelCallRequest,
  ModelCallResult,
} from "./types.ts";

export interface FixtureTurn {
  /** Assistant text replayed for this call. */
  response: string;
  /** Optional artificial delay to exercise timeout budgets. */
  delayMs?: number;
}

/**
 * Test double at the model boundary. Captures every request that would have
 * left the machine (the privacy assertions read these) and replays scripted
 * responses in order. Real traffic never runs through this class.
 *
 * With a statePath the consumed-turn counter persists across CLI invocations
 * (record/replay semantics: one scripted turn per real model call, ever).
 */
export class FixtureCaller implements ModelCaller {
  readonly name = "fixture";
  readonly capturedRequests: ModelCallRequest[] = [];
  private consumed: number;

  constructor(
    private readonly turns: FixtureTurn[],
    private readonly statePath?: string,
  ) {
    if (statePath && existsSync(statePath)) {
      this.consumed = Number.parseInt(readFileSync(statePath, "utf8"), 10) || 0;
    } else {
      this.consumed = 0;
    }
  }

  async call(request: ModelCallRequest): Promise<ModelCallResult> {
    this.capturedRequests.push(structuredClone(request));
    const turn = this.turns[this.consumed];
    this.consumed += 1;
    if (this.statePath) {
      writeFileSync(this.statePath, String(this.consumed));
    }
    if (!turn) {
      throw new UserError(
        `fixture exhausted: ${this.turns.length} turn(s) scripted, call ${this.consumed} requested`,
      );
    }
    if (turn.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
    }
    return { text: turn.response, stopReason: "stop" };
  }
}
