// Whether session-events has been told where the transcript is.
//
// The hello names the transcript only when the file exists, and Claude Code
// creates it when the first message arrives, so a hello at session start
// cannot. session-events stamps @claude_transcript from the hello, and the
// agent API reads a turn's answer through that stamp, so the mod says hello
// once more as soon as the file appears.

export class TranscriptStamp {
  #owed = false;

  // A hello went out; `named` is whether it carried the transcript.
  hello(named: boolean): void {
    this.#owed = !named;
  }

  // Whether a hello is still owed.
  get pending(): boolean {
    return this.#owed;
  }

  // Called with whether the file exists now. True once, when it has appeared
  // since a hello that could not name it: say hello again.
  appeared(exists: boolean): boolean {
    if (!this.#owed || !exists) return false;
    this.#owed = false;
    return true;
  }
}
