/** Pure elapsed-play accounting; the runtime owns sampling and any timer resource. */
export class ActivePlayClock {
  readonly #intervalMs = 60_000;
  #lastMs: number | undefined;
  #elapsedMs = 0;
  #playing = false;

  setPlaying(playing: boolean, nowMs: number): void {
    this.#advance(nowMs);
    this.#playing = playing;
  }

  /** A delayed sample reserves at most one poll and discards missed intervals. */
  poll(nowMs: number): boolean {
    this.#advance(nowMs);
    if (!this.#playing || this.#elapsedMs < this.#intervalMs) return false;
    this.#elapsedMs = 0;
    return true;
  }

  #advance(nowMs: number): void {
    if (
      !Number.isFinite(nowMs) ||
      nowMs < 0 ||
      (this.#lastMs !== undefined && nowMs < this.#lastMs)
    )
      throw new Error("Invalid monotonic time");
    if (this.#playing && this.#lastMs !== undefined)
      this.#elapsedMs = Math.min(this.#intervalMs, this.#elapsedMs + nowMs - this.#lastMs);
    this.#lastMs = nowMs;
  }
}
