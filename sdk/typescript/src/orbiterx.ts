import { OrbiterXOptions } from "./orbiterxOptions";
import { OrbiterXExec } from "./exec";
import { Thread } from "./thread";
import { ThreadOptions } from "./threadOptions";

/**
 * OrbiterX is the main class for interacting with the OrbiterX agent.
 *
 * Use the `startThread()` method to start a new thread or `resumeThread()` to resume a previously started thread.
 */
export class OrbiterX {
  private exec: OrbiterXExec;
  private options: OrbiterXOptions;

  constructor(options: OrbiterXOptions = {}) {
    const { orbiterxPathOverride, env, config } = options;
    this.exec = new OrbiterXExec(orbiterxPathOverride, env, config);
    this.options = options;
  }

  /**
   * Starts a new conversation with an agent.
   * @returns A new thread instance.
   */
  startThread(options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, options);
  }

  /**
   * Resumes a conversation with an agent based on the thread id.
   * Threads are persisted in ~/.orbiterx/sessions.
   *
   * @param id The id of the thread to resume.
   * @returns A new thread instance.
   */
  resumeThread(id: string, options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, options, id);
  }
}
