import { execFile } from "node:child_process";

// Every `acli` call the server makes goes through one runner, so the Issues sync and link titles share its limits.
// acli signs in with OAuth and refreshes its token at auth.atlassian.com; when that service is down every call fails or
// hangs. Without limits a sync stalls on a call that never returns, and link titles, which split a failing batch to find
// a bad key, spawn more calls the worse it gets. So each call has a deadline, only a few run at once, and a failure that
// looks like an outage pauses all calls with a growing delay, logged once when it starts and once when it ends.

export class AcliUnavailableError extends Error {}

type Exec = (command: string, args: string[], options: { cwd?: string; timeout: number; maxBuffer: number }) => Promise<string>;

const OUTAGE = /unauthori[sz]ed|auth login|oauth2|cannot fetch token|\b50[234]\b|upstream connect|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i;

const execAcli: Exec = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { ...options, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const timedOut = (error as { killed?: boolean }).killed === true;
    const detail = `${String(stderr || "").trim()} ${error.message}`.trim();
    reject(Object.assign(new Error(timedOut ? `acli timed out after ${options.timeout / 1000}s: ${args.slice(0, 3).join(" ")}` : detail), { timedOut }));
  });
});

type Log = { info(message: string): void; warn(message: string): void };
type Options = { exec?: Exec; timeoutMs?: number; concurrency?: number; firstPauseMs?: number; maxPauseMs?: number; now?: () => number; log?: Log };

export function createAcliRunner({ exec = execAcli, timeoutMs = 90_000, concurrency = 4, firstPauseMs = 60_000, maxPauseMs = 30 * 60_000, now = Date.now, log = console }: Options = {}) {
  let running = 0;
  const waiting: (() => void)[] = [];
  let pausedUntil = 0;
  let pauseMs = 0;
  let reason = "";

  const acquire = () => running < concurrency ? (running++, Promise.resolve()) : new Promise<void>((resolve) => waiting.push(() => { running++; resolve(); }));
  const release = () => { running--; waiting.shift()?.(); };

  function unavailable() {
    return new AcliUnavailableError(`acli paused until ${new Date(pausedUntil).toISOString()} after: ${reason}`);
  }

  async function run(command: string[], args: string[], { cwd, maxBuffer = 64 << 20 }: { cwd?: string; maxBuffer?: number } = {}) {
    if (now() < pausedUntil) throw unavailable();
    await acquire();
    try {
      // A call queued behind ones that just opened the pause doesn't start either.
      if (now() < pausedUntil) throw unavailable();
      const [bin, ...rest] = command;
      const out = await exec(bin, [...rest, ...args], { cwd, timeout: timeoutMs, maxBuffer });
      if (pauseMs) log.info(`acli is answering again; Jira lookups resumed`);
      pauseMs = 0;
      pausedUntil = 0;
      return out;
    } catch (error) {
      if (error instanceof AcliUnavailableError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if ((error as { timedOut?: boolean }).timedOut || OUTAGE.test(message)) {
        const first = !pauseMs;
        pauseMs = Math.min(pauseMs ? pauseMs * 2 : firstPauseMs, maxPauseMs);
        pausedUntil = now() + pauseMs;
        reason = message.split("\n")[0].slice(0, 200);
        if (first) log.warn(`acli looks unavailable, pausing Jira lookups (retry in ${pauseMs / 1000}s): ${reason}`);
        throw unavailable();
      }
      throw error;
    } finally {
      release();
    }
  }

  return { run, state: () => ({ running, queued: waiting.length, pausedUntil, pauseMs }) };
}

export const acli = createAcliRunner();
