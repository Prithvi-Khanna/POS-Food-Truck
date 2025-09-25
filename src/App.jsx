import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "./OfflineDataStore";
import { syncEngine } from "./SyncEngine";
import { printManager } from "./PrintJobManager";
import "./App.css";

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
      return () => {
        mountedRef.current = false;
        syncEngine.stopAuto();
        if (printInterval) clearInterval(printInterval);
        if (onPrintChange) store.off("printjobs:changed", onPrintChange);
        if (onOrdersChange) store.off("orders:changed", onOrdersChange);
      };
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
      <div className="dish-row" style={style}>
        <div className="dish-row-info">
          <div className="dish-row-name">{currentDish.name}</div>
          <div className="dish-row-category">
            {currentDish.category} • ₹{currentDish.price}
          </div>
        </div>
        <div className="dish-row-action">
          <button
            onClick={() => addToCart(String(currentDish.id))}
            className="add-btn"
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
      <div className="cart-item">
        <div className="cart-item-info">
          <div className="cart-item-name">{currentDish.name}</div>
          <div className="cart-item-meta">
            ₹{currentDish.price} • opts: {JSON.stringify(dishItem.opts || {})}
          </div>
        </div>
        <div className="cart-item-actions">
          <input
            type="number"
            min="1"
            value={dishItem.qty}
            onChange={(e) =>
              setQty(idx, Math.max(1, parseInt(e.target.value || 1)))
            }
            className="qty-input"
          />
          <button onClick={() => removeItem(idx)} aria-label="remove">
            Remove
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="main-container">
      <header className="header">
        <h1 className="header-title">Food Truck POS</h1>
        <div className="header-status">
          {navigator.onLine ? "Online" : "Offline"}
        </div>
      </header>

      <div className="main-grid">
        <section className="menu-section">
          <div className="search-bar">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search dishes (name or category)"
              className="search-input"
            />
            <button onClick={() => setQuery("")} className="clear-btn">
              Clear
            </button>
          </div>

          <div className="menu-list">
            {filtered.length === 0 ? (
              <div className="no-dishes">No dishes found</div>
            ) : (
              <div className="menu-scroll">
                {filtered.map((_, index) => (
                  <Row key={filtered[index].id} index={index} />
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="cart-aside">
          <div>
            <h3 className="cart-title">Cart</h3>
            <div className="cart-list">
              {cart.length === 0 ? (
                <div className="cart-empty">Cart is empty</div>
              ) : (
                cart.map((dishItem, idx) => (
                  <CartItem key={idx} dishItem={dishItem} idx={idx} />
                ))
              )}
            </div>
            <div className="cart-total">Total: ₹{totalCart}</div>
            <div className="cart-actions">
              <button
                onClick={handleCheckout}
                disabled={!cart.length}
                className="checkout-btn"
              >
                Checkout
              </button>
              <button
                onClick={() => setCart([])}
                disabled={!cart.length}
                className="clear-cart-btn"
              >
                Clear
              </button>
            </div>
          </div>

          <div>
            <h4 className="print-title">Print Jobs</h4>
            <div className="print-list">
              {printJobs.length === 0 ? (
                <div className="print-empty">No print jobs</div>
              ) : (
                printJobs.map((printJob) => (
                  <div key={printJob.id} className="print-job">
                    <div>
                      <strong>{printJob.destination}</strong> •{" "}
                      {printJob.status}{" "}
                      {printJob.retries ? `• retries:${printJob.retries}` : ""}
                    </div>
                    <div className="print-job-meta">
                      {printJob.template?.slice?.(0, 120) ||
                        JSON.stringify(printJob.meta || {})}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h4 className="orders-title">Recent Orders</h4>
            <div className="orders-list">
              {orders.length === 0 ? (
                <div className="orders-empty">No orders yet</div>
              ) : (
                orders.slice(0, 8).map((order) => (
                  <div key={order.id} className="order-item">
                    <div>
                      <strong>{order.id}</strong> • {order.status}
                    </div>
                    <div className="order-meta">
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
