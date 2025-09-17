import { store } from "./OfflineDataStore";

class PrintJobManager {
  constructor(store) {
    this.store = store;
    this.processing = false;
    this.timers = new Map();
    this.logs = [];
  }

  async enqueue({
    destination = "receipt",
    priority = 0,
    template = "",
    meta = {},
  }) {
    const job = {
      destination,
      priority,
      template,
      meta,
      status: "queued",
      retries: 0,
      createdAt: Date.now(),
    };
    return this.store.enqueuePrintJob(job);
  }

  async _getNextQueued() {
    const all = await this.store.getPrintJobs();
    return all
      .filter((j) => j.status === "queued" || j.status === "retry")
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  }

  async processLoop() {
    if (this.processing || this.paused) return;
    this.processing = true;
    try {
        const q = await this._getNextQueued();
        if (!q || q.length === 0) return;
        const job = q[0];
        await this._processJob(job);
    } finally {
      this.processing = false;
    }
  }

  async _processJob(job) {
    const jobId = job.id;
    await this.store.updatePrintJob(jobId, {
      status: "processing",
      lastAttemptAt: Date.now(),
    });

    try {
          // Send for Printing-- job

      await this.store.updatePrintJob(jobId, {
        status: "done",
        doneAt: Date.now(),
      });
      this.store._emit("print:done", job);
      this.logs.push(
        `[printer] done ${
          job.destination
        }#${jobId} @ ${new Date().toLocaleTimeString()}`
      );
      if (this.timers.has(jobId)) {
        clearTimeout(this.timers.get(jobId));
        this.timers.delete(jobId);
      }
    } catch (err) {
      const retries = (job.retries || 0) + 1;
      const maxRetries = 5;
      if (retries > maxRetries) {
        await this.store.updatePrintJob(jobId, {
          status: "failed",
          error: String(err),
          retries,
        });
        this.store._emit("print:failed", { job, error: err });
        this.logs.push(`[printer] failed ${jobId} after ${retries} attempts`);
      } else {
        const delay = Math.min(30000, 500 * 2 ** (retries - 1));
        await this.store.updatePrintJob(jobId, {
          status: "retry",
          retries,
          nextAttemptAt: Date.now() + delay,
        });
        this.logs.push(
          `[printer] retry ${jobId} in ${delay}ms (attempt ${retries})`
        );
        const t = setTimeout(() => {
          this.processLoop();
        }, delay);
        this.timers.set(jobId, t);
      }
    }
  }
}

export const printManager = new PrintJobManager(store);