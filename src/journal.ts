/**
 * Journal — append-only NDJSON event log for a run.
 *
 * Written as the run happens to `artifacts/<runId>/journal.ndjson`. The
 * journal is the audit trail: grep it when a reviewer asks what happened at
 * a given moment. Events are lowercase, short, grepable.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { JournalEvent, SurfaceName } from "./types.ts";

export class Journal {
  readonly path: string;
  #stream: WriteStream;
  #counts = { rewinds: 0, artifacts: 0 };

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#stream = createWriteStream(path, { flags: "a" });
  }

  /** Append one event with a fresh timestamp. */
  write(event: JournalEvent): void {
    if (event.type === "rewind") this.#counts.rewinds += 1;
    if (event.type === "artifact") this.#counts.artifacts += 1;
    this.#stream.write(JSON.stringify(event) + "\n");
  }

  /** Convenience wrappers so call sites read like the log format. */
  stepStart(id: string, surface: SurfaceName): void {
    this.write({ t: Date.now(), type: "step.start", id, surface });
  }

  stepOk(id: string, ms: number): void {
    this.write({ t: Date.now(), type: "step.ok", id, ms });
  }

  stepFail(id: string, error: string, screenshot?: string): void {
    this.write({ t: Date.now(), type: "step.fail", id, error, ...(screenshot ? { screenshot } : {}) });
  }

  rewind(from: string, snapshot: string): void {
    this.write({ t: Date.now(), type: "rewind", from, snapshot });
  }

  cost(usd: number): void {
    this.write({ t: Date.now(), type: "cost", usd });
  }

  artifact(path: string): void {
    this.write({ t: Date.now(), type: "artifact", path });
  }

  /** Number of rewind events written so far (feeds `eval.json`). */
  get rewinds(): number {
    return this.#counts.rewinds;
  }

  /** Flush and close the underlying stream. */
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  }
}
