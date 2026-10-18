/** Optional locally synthesized cues; no recording, speech service or audio downloads. */
export class RadioAudio {
  private context: AudioContext | null = null;
  private last = 0;
  enabled = false;
  async setEnabled(value: boolean) {
    this.enabled = value;
    if (value) {
      this.context ??= new AudioContext();
      await this.context.resume();
      this.play("command");
    }
  }
  play(kind: "command" | "readback" | "alert") {
    if (!this.enabled || !this.context || this.context.state !== "running") return;
    const now = this.context.currentTime;
    if (now - this.last < .18) return;
    this.last = now;
    const frequencies = kind === "alert" ? [650, 480] : kind === "readback" ? [710, 920] : [820];
    frequencies.forEach((frequency, i) => {
      const osc = this.context!.createOscillator(), gain = this.context!.createGain();
      const start = now + i * .11;
      osc.type = "sine"; osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.045, start + .012); gain.gain.exponentialRampToValueAtTime(.001, start + .09);
      osc.connect(gain); gain.connect(this.context!.destination); osc.start(start); osc.stop(start + .1);
    });
  }
  dispose() { void this.context?.close(); this.context = null; }
}
