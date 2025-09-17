import { db, store } from "./OfflineDataStore";

class SyncEngine {
  constructor(store) {
    this.store = store;
    this.running = false;
    this.backoff = 1000;
    this.maxBackoff = 30000;
    this.timer = null;
    this.syncStatus = "idle";
  }

  startAuto(interval = 6000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.syncOnce();
    }, interval);
    window.addEventListener("online", () => this.syncOnce());
    this.syncOnce();
  }

  stopAuto() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async syncOnce() {
    if (!navigator.onLine) {
      this.syncStatus = "offline";
      return { ok: false, offline: true };
    }
    if (this.running) return { ok: false, reason: "already running" };
    this.running = true;
    this.syncStatus = "syncing";
    try {
      const ops = await this.store.drainOplog();
      if (ops.length) {
        const res = await this._pushOpsToServer(ops);
        for (const acked of res.acked || []) {
          await this.store.removeOplogEntry(acked);
        }
      }

      await this._pullDishesFromServer();

      this.syncStatus = "idle";
      this.backoff = 1000;
      return { ok: true };
    } catch (err) {
      // Sync Error-- err
      this.syncStatus = "error";
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
      setTimeout(() => this.syncOnce(), this.backoff);
      return { ok: false, error: err };
    } finally {
      this.running = false;
    }
  }

  async _pushOpsToServer(ops) {
    // "SyncEngine: pushing ops"
    await new Promise((r) => setTimeout(r, 350));
    const acked = ops.map((op) => op.opId).filter(Boolean);
    return { ok: true, acked };
  }

  async _pullDishesFromServer() {
    try {
      const resp = await fetch("https://dummyjson.com/recipes");
      if (!resp.ok) throw new Error("bad response");
      const json = await resp.json();
      const mapped = (json.recipes || []).map((r) => ({
        id: String(r.id),
        name: r.name,
        price: r.caloriesPerServing || 100,
        category: r.cuisine || "General",
        sourceUpdatedAt: Date.now(),
      }));
      await db.transaction("rw", db.dishes, async () => {
        for (const d of mapped) {
          await db.dishes.put(d);
        }
      });
      this.store._emit("dishes:changed", true);
    } catch (err) {
      // Failed to Pull Dishes
    }
  }
}

export const syncEngine = new SyncEngine(store);