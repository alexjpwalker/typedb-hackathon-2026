import { writable, derived } from 'svelte/store';
import type { DonutType, Outlet, OrderBook, Transaction } from './types';
import { api } from './api';
import { websocket, type ErrorData } from './websocket';

// Selected outlet and donut type
export const selectedOutlet = writable<Outlet | null>(null);
export const selectedDonutType = writable<DonutType | null>(null);

// Data stores
export const outlets = writable<Outlet[]>([]);
export const donutTypes = writable<DonutType[]>([]);
export const orderBook = writable<OrderBook | null>(null);
export const transactions = writable<Transaction[]>([]);
export const factory = writable<Outlet | null>(null);

// Loading states
export const loading = writable(false);
export const error = writable<string | null>(null);

// Error log (for displaying backend errors)
export const errorLog = writable<ErrorData[]>([]);

// Initialize stores
export async function initializeStores() {
  loading.set(true);
  error.set(null);

  try {
    // Load outlets, donut types, and factory
    const [outletsData, donutTypesData, factoryData] = await Promise.all([
      api.getOutlets(),
      api.getDonutTypes(),
      api.getFactory().catch(() => null) // Factory might not exist yet
    ]);

    outlets.set(outletsData);
    donutTypes.set(donutTypesData);
    factory.set(factoryData);

    // Set defaults if available
    if (outletsData.length > 0) {
      selectedOutlet.set(outletsData[0]);
    }
    if (donutTypesData.length > 0) {
      selectedDonutType.set(donutTypesData[0]);
    }

    // Connect WebSocket for real-time updates
    websocket.connect();

    // Subscribe to WebSocket events
    websocket.on('trade_executed', (message) => {
      const transaction = message.data as Transaction;
      transactions.update(txs => [transaction, ...txs].slice(0, 100));

      // Refresh order book if it's for the selected donut type
      selectedDonutType.subscribe(async (donutType) => {
        if (donutType && transaction.donutTypeId === donutType.donutTypeId) {
          await refreshOrderBook(donutType.donutTypeId);
        }
      })();

      // Refresh outlets to update balances
      refreshOutlets();
    });

    websocket.on('order_book_updated', (message) => {
      const book = message.data as OrderBook;
      selectedDonutType.subscribe(async (donutType) => {
        if (donutType && book.donutTypeId === donutType.donutTypeId) {
          // Re-fetch with current showFilledOrders setting instead of using broadcast data
          await refreshOrderBook(donutType.donutTypeId);
        }
      })();
    });

    websocket.on('error', (message) => {
      const errorData = message.data as ErrorData;
      errorLog.update(logs => [errorData, ...logs].slice(0, 100)); // Keep last 100 errors
    });

  } catch (err) {
    console.error('Failed to initialize stores:', err);

    // Provide helpful error messages
    let errorMessage = 'Failed to initialize';

    if (err instanceof TypeError && err.message.includes('fetch')) {
      errorMessage = 'Cannot connect to backend server. Please ensure the backend is running at http://localhost:3000';
    } else if (err instanceof Error) {
      errorMessage = err.message;
    }

    error.set(errorMessage);
  } finally {
    loading.set(false);
  }
}

// Order book settings
export const showFilledOrders = writable(false);

// Refresh functions
export async function refreshOrderBook(donutTypeId: string, includeAll?: boolean) {
  try {
    // Use the passed value or get current setting
    let include = includeAll;
    if (include === undefined) {
      showFilledOrders.subscribe(v => include = v)();
    }
    const book = await api.getOrderBook(donutTypeId, include);
    orderBook.set(book);
  } catch (err) {
    console.error('Failed to refresh order book:', err);
  }
}

export async function refreshTransactions(donutTypeId?: string) {
  try {
    const txs = donutTypeId
      ? await api.getTransactionsByDonutType(donutTypeId, 50)
      : await api.getTransactions(50);
    transactions.set(txs);
  } catch (err) {
    console.error('Failed to refresh transactions:', err);
  }
}

export async function refreshOutlets() {
  try {
    const outletsData = await api.getOutlets();
    outlets.set(outletsData);

    // Update selected outlet if it exists
    selectedOutlet.subscribe((selected) => {
      if (selected) {
        const updated = outletsData.find(o => o.outletId === selected.outletId);
        if (updated) {
          selectedOutlet.set(updated);
        }
      }
    })();
  } catch (err) {
    console.error('Failed to refresh outlets:', err);
  }
}

export async function refreshFactory() {
  try {
    const factoryData = await api.getFactory();
    factory.set(factoryData);
  } catch (err) {
    console.error('Failed to refresh factory:', err);
  }
}

export async function toggleFactory(isOpen: boolean) {
  try {
    const result = await api.toggleFactory(isOpen);
    if (result.factory) {
      factory.set(result.factory);
    }
  } catch (err) {
    console.error('Failed to toggle factory:', err);
    throw err;
  }
}

export async function toggleOutlet(outletId: string, isOpen: boolean) {
  try {
    await api.toggleOutlet(outletId, isOpen);
    await refreshOutlets();
  } catch (err) {
    console.error('Failed to toggle outlet:', err);
    throw err;
  }
}

// Derived stores
export const bestBid = derived(orderBook, ($orderBook) => {
  if (!$orderBook || $orderBook.buyOrders.length === 0) return null;
  return $orderBook.buyOrders[0];
});

export const bestAsk = derived(orderBook, ($orderBook) => {
  if (!$orderBook || $orderBook.sellOrders.length === 0) return null;
  return $orderBook.sellOrders[0];
});

export const spread = derived([bestBid, bestAsk], ([$bestBid, $bestAsk]) => {
  if (!$bestBid || !$bestAsk) return null;
  return $bestAsk.pricePerUnit - $bestBid.pricePerUnit;
});

// Subscribe to selected donut type changes
selectedDonutType.subscribe((donutType) => {
  if (donutType) {
    refreshOrderBook(donutType.donutTypeId);
    refreshTransactions(donutType.donutTypeId);
  }
});
