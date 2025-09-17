import Dexie from "dexie";

const DB_NAME = "FoodTruckPOS";
const DB_VERSION = 1;

export const db = new Dexie(DB_NAME);
db.version(DB_VERSION).stores({
  dishes: "id,name,category",
  orders: "id,status,updatedAt,version",
  oplog: "++opId,ts,type",
  printjobs: "++id,priority,status",
});

class OfflineDataStore {
  constructor() {
    this.emitter = new Map();
  }

  on(event, cb) {
    if (!this.emitter.has(event)) this.emitter.set(event, new Set());
    this.emitter.get(event).add(cb);
  }
  off(event, cb) {
    this.emitter.get(event)?.delete(cb);
  }
  _emit(event, payload) {
    const set = this.emitter.get(event);
    if (!set) return;
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {
        // Error -- e
      }
    });
  }

  async bulkAddDishes(dishes) {
    return db.transaction("rw", db.dishes, async () => {
      await db.dishes.bulkPut(dishes);
      this._emit("dishes:changed", true);
    });
  }
  async getDishes() {
    return db.dishes.toArray();
  }

  async addOrder(order) {
    return db
      .transaction("rw", [db.orders, db.oplog], async () => {
        await db.orders.put(order);
        const op = {
          ts: Date.now(),
          type: "create_order",
          payload: order,
        };
        const insertedOpId = await db.oplog.add(op);
        op.opId = insertedOpId;
        this._emit("orders:changed", order);
        this._emit("oplog:queued", op);
        return { order, opId: insertedOpId };
      })
      .catch((err) => {
        // Error-- e
        throw err;
      });
  }

  async getOrders(filter = {}) {
    if (filter.status)
      return db.orders.where("status").equals(filter.status).toArray();
    return db.orders.toArray();
  }

  async drainOplog() {
    return db.oplog.orderBy("ts").toArray();
  }
  async removeOplogEntry(opId) {
    await db.oplog.delete(opId);
    this._emit("oplog:dequeued", opId);
  }

  async enqueuePrintJob(job) {
    job.status = job.status || "queued";
    job.createdAt = Date.now();
    const id = await db.printjobs.add(job);
    const saved = await db.printjobs.get(id);
    this._emit("printjobs:changed", saved);
    return saved;
  }
  async getPrintJobs() {
    return db.printjobs.toArray();
  }
  async updatePrintJob(id, patch) {
    await db.printjobs.update(id, patch);
    const job = await db.printjobs.get(id);
    this._emit("printjobs:changed", job);
    return job;
  }

}

export const store = new OfflineDataStore();