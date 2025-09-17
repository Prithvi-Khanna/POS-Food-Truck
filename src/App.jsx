import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "./OfflineDataStore";
import { syncEngine } from "./SyncEngine";
import { printManager } from "./PrintJobManager";

const calcOrderTotal = (items, dishesMap) => {
  let total = 0;
  for (const dishItem of items) {
    const currentDish = dishesMap[dishItem.dishId];
    if (currentDish) total += (currentDish.price || 0) * (dishItem.qty || 1);
  }
  return total;
};

export default function App() {
  const [dishes, setDishes] = useState([]);
  const [dishesMap, setDishesMap] = useState({});
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState([]);
  const [printJobs, setPrintJobs] = useState([]);
  const [orders, setOrders] = useState([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      const cached = await store.getDishes();
      if (cached && cached.length) {
        setDishes(cached);
        setDishesMap(
          Object.fromEntries(
            cached.map((currentDish) => [currentDish.id, currentDish])
          )
        );
      }

      try {
        await syncEngine._pullDishesFromServer();
        const after = await store.getDishes();
        if (after && after.length) {
          setDishes(after);
          setDishesMap(
            Object.fromEntries(
              after.map((currentDish) => [currentDish.id, currentDish])
            )
          );
        }
      } catch (err) {
        // initial fetch failed-- err
      }

      syncEngine.startAuto(6000);
      const printInterval = setInterval(() => printManager.processLoop(), 2000);

      const onPrintChange = async () => {
        const jobs = await store.getPrintJobs();
        if (!mountedRef.current) return;
        setPrintJobs(
          jobs.sort(
            (a, b) => b.priority - a.priority || a.createdAt - b.createdAt
          )
        );
      };
      const onOrdersChange = async () => {
        const order = await store.getOrders();
        if (!mountedRef.current) return;
        setOrders(order.sort((a, b) => b.updatedAt - a.updatedAt));
      };
      store.on("printjobs:changed", onPrintChange);
      store.on("orders:changed", onOrdersChange);
      await onPrintChange();
      await onOrdersChange();
      return () => clearInterval(printInterval);
    })();

    return () => {
      mountedRef.current = false;
      syncEngine.stopAuto();
    };
  }, []);

  const filtered = useMemo(() => {
    if (!query) return dishes;
    const q = query.toLowerCase();
    return dishes.filter(
      (currentDish) =>
        (currentDish.name || "").toLowerCase().includes(q) ||
        (currentDish.category || "").toLowerCase().includes(q)
    );
  }, [dishes, query]);

  const addToCart = (dishId, opts = {}) => {
    setCart((prev) => {
      const exIdx = prev.findIndex(
        (dishItem) =>
          dishItem.dishId === dishId &&
          JSON.stringify(dishItem.opts) === JSON.stringify(opts)
      );
      if (exIdx >= 0) {
        const next = [...prev];
        next[exIdx] = { ...next[exIdx], qty: next[exIdx].qty + 1 };
        return next;
      }
      return [...prev, { dishId, qty: 1, opts }];
    });
  };

  const setQty = (index, qty) =>
    setCart((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], qty };
      return next;
    });
  const removeItem = (index) =>
    setCart((prev) => prev.filter((_, i) => i !== index));

  const handleCheckout = async () => {
    if (!cart.length) return;
    const order = {
      id: `order-${Date.now()}`,
      items: cart.map((dishItem) => ({
        dishId: dishItem.dishId,
        qty: dishItem.qty,
        opts: dishItem.opts,
      })),
      total: calcOrderTotal(cart, dishesMap),
      status: "pending",
      updatedAt: Date.now(),
      version: 1,
    };
    setOrders((prev) => [order, ...prev]);
    try {
      const { order: savedOrder } = await store.addOrder(order);
      const lines = savedOrder.items
        .map((dishItem) => {
          const currentDish = dishesMap[dishItem.dishId];
          return `${currentDish?.name || dishItem.dishId} x${dishItem.qty} - ₹${
            (currentDish?.price || 0) * dishItem.qty
          }`;
        })
        .join("\n");

      const receiptTpl = ["=== Food Truck ===", "Dishes:", lines].join("\n");
      await store.enqueuePrintJob({
        destination: "receipt",
        priority: 1,
        template: receiptTpl,
        meta: { orderId: savedOrder.id, lines, total: savedOrder.total },
      });
      const kitchenTpl = ["=== KITCHEN ===", lines].join("\n");
      await store.enqueuePrintJob({
        destination: "kitchen",
        priority: 2,
        template: kitchenTpl,
        meta: { orderId: savedOrder.id, lines },
      });

      printManager.processLoop();
      setCart([]);
    } catch (err) {
      // checkout failederr
      const order = await store.getOrders();
      setOrders(order.sort((a, b) => b.updatedAt - a.updatedAt));
    }
  };

  const totalCart = useMemo(
    () => calcOrderTotal(cart, dishesMap),
    [cart, dishesMap]
  );

  const Row = ({ index, style }) => {
    const currentDish = filtered[index];
    if (!currentDish) return null;
    return (
      <div
        style={{
          ...style,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          boxSizing: "border-box",
          borderBottom: "1px solid #eee",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {currentDish.name}
          </div>
          <div style={{ fontSize: 12, color: "#666" }}>
            {currentDish.category} • ₹{currentDish.price}
          </div>
        </div>
        <div style={{ marginLeft: 12 }}>
          <button
            onClick={() => addToCart(String(currentDish.id))}
            style={{ padding: "6px 10px", touchAction: "manipulation" }}
          >
            Add
          </button>
        </div>
      </div>
    );
  };

  const CartItem = ({ dishItem, idx }) => {
    const currentDish = dishesMap[dishItem.dishId] || {
      name: dishItem.dishId,
      price: 0,
    };
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 0",
          borderBottom: "1px solid #f2f2f2",
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{currentDish.name}</div>
          <div style={{ fontSize: 12, color: "#666" }}>
            ₹{currentDish.price} • opts: {JSON.stringify(dishItem.opts || {})}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min="1"
            value={dishItem.qty}
            onChange={(e) =>
              setQty(idx, Math.max(1, parseInt(e.target.value || 1)))
            }
            style={{ width: 64, padding: 6 }}
          />
          <button onClick={() => removeItem(idx)} aria-label="remove">
            Remove
          </button>
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        padding: 16,
        fontFamily: "system-ui, -apple-system, Roboto, Arial",
        maxWidth: 1100,
        margin: "0 auto",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h1 style={{ margin: 0 }}>Food Truck POS</h1>
        <div style={{ fontSize: 13, color: "#444" }}>
          {navigator.onLine ? "Online" : "Offline"}
        </div>
      </header>

      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 16 }}
      >
        <section style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search dishes (name or category)"
              style={{ flex: 1, padding: 8 }}
            />
            <button
              onClick={() => setQuery("")}
              style={{ padding: "8px 12px" }}
            >
              Clear
            </button>
          </div>

          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {filtered.length === 0 ? (
              <div style={{ padding: 20 }}>No dishes found</div>
            ) : (
              <div style={{ maxHeight: 500, overflowY: "auto" }}>
                {filtered.map((_, index) => (
                  <Row key={filtered[index].id} index={index} />
                ))}
              </div>
            )}
          </div>
        </section>

        <aside
          style={{
            border: "1px solid #eee",
            borderRadius: 8,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div>
            <h3 style={{ margin: "4px 0" }}>Cart</h3>
            <div style={{ minHeight: 160 }}>
              {cart.length === 0 ? (
                <div style={{ color: "#888" }}>Cart is empty</div>
              ) : (
                cart.map((dishItem, idx) => (
                  <CartItem key={idx} dishItem={dishItem} idx={idx} />
                ))
              )}
            </div>
            <div style={{ marginTop: 8, fontWeight: 700 }}>
              Total: ₹{totalCart}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                onClick={handleCheckout}
                disabled={!cart.length}
                style={{
                  padding: "10px 14px",
                  background: "#0b7",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  touchAction: "manipulation",
                }}
              >
                Checkout
              </button>
              <button
                onClick={() => setCart([])}
                disabled={!cart.length}
                style={{ padding: "10px 14px" }}
              >
                Clear
              </button>
            </div>
          </div>

          <div>
            <h4 style={{ margin: "4px 0" }}>Print Jobs</h4>
            <div style={{ maxHeight: 160, overflow: "auto", fontSize: 13 }}>
              {printJobs.length === 0 ? (
                <div style={{ color: "#888" }}>No print jobs</div>
              ) : (
                printJobs.map((printJob) => (
                  <div
                    key={printJob.id}
                    style={{
                      padding: "6px 0",
                      borderBottom: "1px dashed #eee",
                    }}
                  >
                    <div>
                      <strong>{printJob.destination}</strong> •{" "}
                      {printJob.status}{" "}
                      {printJob.retries ? `• retries:${printJob.retries}` : ""}
                    </div>
                    <div style={{ color: "#444", fontSize: 12 }}>
                      {printJob.template?.slice?.(0, 120) ||
                        JSON.stringify(printJob.meta || {})}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h4 style={{ margin: "4px 0" }}>Recent Orders</h4>
            <div style={{ maxHeight: 160, overflow: "auto", fontSize: 13 }}>
              {orders.length === 0 ? (
                <div style={{ color: "#888" }}>No orders yet</div>
              ) : (
                orders.slice(0, 8).map((order) => (
                  <div
                    key={order.id}
                    style={{
                      padding: "6px 0",
                      borderBottom: "1px dashed #eee",
                    }}
                  >
                    <div>
                      <strong>{order.id}</strong> • {order.status}
                    </div>
                    <div style={{ fontSize: 12 }}>
                      {order.items
                        .map(
                          (dishItem) =>
                            (dishesMap[dishItem.dishId]?.name ||
                              dishItem.dishId) +
                            " x" +
                            dishItem.qty
                        )
                        .join(", ")}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
