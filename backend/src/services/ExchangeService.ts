import { OrderRepository } from '../repositories/OrderRepository.js';
import { TransactionRepository } from '../repositories/TransactionRepository.js';
import { OutletRepository } from '../repositories/OutletRepository.js';
import { DonutTypeRepository } from '../repositories/DonutTypeRepository.js';
import { InventoryRepository } from '../repositories/InventoryRepository.js';
import { CustomerSaleRepository } from '../repositories/CustomerSaleRepository.js';
import { MatchingEngine } from '../engine/MatchingEngine.js';
import { CreateOrderRequest, Order, OrderBook, Transaction, Outlet, DonutType, OutletStats, CustomerSale } from '../models/types.js';

type OrderBookUpdatedCallback = (orderBook: OrderBook) => void;

// Cache for sales statistics (backed by DB)
interface OutletSalesStats {
  customerSalesRevenue: number;
  customerSalesCount: number;
  exchangeSalesRevenue: number;
  exchangeSalesCount: number;
}

// In-memory cache for inventory (synced with DB)
type InventoryMap = Map<string, Map<string, number>>;

export class ExchangeService {
  private orderRepo: OrderRepository;
  private transactionRepo: TransactionRepository;
  private outletRepo: OutletRepository;
  private donutTypeRepo: DonutTypeRepository;
  private inventoryRepo: InventoryRepository;
  private customerSaleRepo: CustomerSaleRepository;
  private matchingEngine: MatchingEngine;

  // Cache for sales stats per outlet (backed by DB)
  private salesStatsCache: Map<string, OutletSalesStats> = new Map();

  // Cache for inventory (backed by DB)
  private inventoryCache: InventoryMap = new Map();

  // Callbacks for order book updates
  private orderBookCallbacks: OrderBookUpdatedCallback[] = [];

  constructor() {
    this.orderRepo = new OrderRepository();
    this.transactionRepo = new TransactionRepository();
    this.outletRepo = new OutletRepository();
    this.donutTypeRepo = new DonutTypeRepository();
    this.inventoryRepo = new InventoryRepository();
    this.customerSaleRepo = new CustomerSaleRepository();
    this.matchingEngine = new MatchingEngine();
  }

  private getOrCreateStats(outletId: string): OutletSalesStats {
    if (!this.salesStatsCache.has(outletId)) {
      this.salesStatsCache.set(outletId, {
        customerSalesRevenue: 0,
        customerSalesCount: 0,
        exchangeSalesRevenue: 0,
        exchangeSalesCount: 0
      });
    }
    return this.salesStatsCache.get(outletId)!;
  }

  private getInventoryFromCache(outletId: string, donutTypeId: string): number {
    const outletInventory = this.inventoryCache.get(outletId);
    if (!outletInventory) return 0;
    return outletInventory.get(donutTypeId) || 0;
  }

  private updateCache(outletId: string, donutTypeId: string, quantity: number): void {
    if (!this.inventoryCache.has(outletId)) {
      this.inventoryCache.set(outletId, new Map());
    }
    this.inventoryCache.get(outletId)!.set(donutTypeId, quantity);
  }

  private async addInventory(outletId: string, donutTypeId: string, quantity: number): Promise<void> {
    const current = this.getInventoryFromCache(outletId, donutTypeId);
    const newQty = current + quantity;
    this.updateCache(outletId, donutTypeId, newQty);
    // Persist to DB (with retry on conflict)
    try {
      await this.inventoryRepo.setInventory(outletId, donutTypeId, newQty);
    } catch (error) {
      console.error(`Error persisting inventory add for ${outletId}/${donutTypeId}:`, error);
      // Retry once after a short delay
      setTimeout(async () => {
        try {
          await this.inventoryRepo.setInventory(outletId, donutTypeId, this.getInventoryFromCache(outletId, donutTypeId));
        } catch (retryError) {
          console.error(`Retry failed for inventory ${outletId}/${donutTypeId}:`, retryError);
        }
      }, 500);
    }
  }

  private async removeInventory(outletId: string, donutTypeId: string, quantity: number): Promise<boolean> {
    const current = this.getInventoryFromCache(outletId, donutTypeId);
    if (current < quantity) return false;
    const newQty = current - quantity;
    this.updateCache(outletId, donutTypeId, newQty);
    // Persist to DB (with retry on conflict)
    try {
      await this.inventoryRepo.setInventory(outletId, donutTypeId, newQty);
    } catch (error) {
      console.error(`Error persisting inventory remove for ${outletId}/${donutTypeId}:`, error);
      // Retry once after a short delay
      setTimeout(async () => {
        try {
          await this.inventoryRepo.setInventory(outletId, donutTypeId, this.getInventoryFromCache(outletId, donutTypeId));
        } catch (retryError) {
          console.error(`Retry failed for inventory ${outletId}/${donutTypeId}:`, retryError);
        }
      }, 500);
    }
    return true;
  }

  private async loadInventoryFromDB(): Promise<void> {
    console.log('Loading inventory from database...');
    const allInventory = await this.inventoryRepo.getAllInventory();
    for (const record of allInventory) {
      this.updateCache(record.outletId, record.donutTypeId, record.quantity);
    }
    console.log(`Loaded ${allInventory.length} inventory records from database`);
  }

  private async loadSalesStatsFromDB(): Promise<void> {
    console.log('Loading sales stats from database...');
    // Load customer sales stats
    const customerStats = await this.customerSaleRepo.getAllOutletSalesStats();
    for (const [outletId, stats] of customerStats) {
      const outletStats = this.getOrCreateStats(outletId);
      outletStats.customerSalesRevenue = stats.revenue;
      outletStats.customerSalesCount = stats.count;
    }
    console.log(`Loaded customer sales stats for ${customerStats.size} outlets`);

    // Exchange sales stats are already tracked via transactions in DB
    // We could load from trade-execution relations if needed
  }

  async start(): Promise<void> {
    // Load state from database first
    await this.loadInventoryFromDB();
    await this.loadSalesStatsFromDB();

    // Subscribe to trade events for stats and inventory tracking
    this.matchingEngine.onTradeExecuted(async (event) => {
      // Track exchange sale for the seller
      const sellerStats = this.getOrCreateStats(event.sellerOutletId);
      sellerStats.exchangeSalesRevenue += event.totalAmount;
      sellerStats.exchangeSalesCount += 1;

      // Add inventory to the buyer (persisted to DB)
      await this.addInventory(event.buyerOutletId, event.donutTypeId, event.quantity);
      console.log(`📦 Inventory: ${event.buyerOutletId} received ${event.quantity} ${event.donutTypeId} donuts`);
    });

    await this.matchingEngine.start();
  }

  async stop(): Promise<void> {
    await this.matchingEngine.stop();
  }

  onMatchingError(callback: (message: string, source: string) => void): void {
    this.matchingEngine.onError(callback);
  }

  onOrderBookUpdated(callback: OrderBookUpdatedCallback): void {
    this.orderBookCallbacks.push(callback);
  }

  private async emitOrderBookUpdated(donutTypeId: string): Promise<void> {
    if (this.orderBookCallbacks.length === 0) return;
    try {
      const orderBook = await this.orderRepo.getOrderBook(donutTypeId, false);
      for (const callback of this.orderBookCallbacks) {
        try {
          callback(orderBook);
        } catch (error) {
          console.error('Error in order book callback:', error);
        }
      }
    } catch (error) {
      console.error('Error fetching order book for broadcast:', error);
    }
  }

  // ==========================================
  // Order Management
  // ==========================================

  async createOrder(request: CreateOrderRequest): Promise<Order> {
    // Validate outlet exists
    const outlet = await this.outletRepo.findById(request.outletId);
    if (!outlet) {
      throw new Error(`Outlet not found: ${request.outletId}`);
    }

    // Validate donut type exists
    const donutType = await this.donutTypeRepo.findById(request.donutTypeId);
    if (!donutType) {
      throw new Error(`Donut type not found: ${request.donutTypeId}`);
    }

    // Create the order
    const order = await this.orderRepo.create(request);

    // Attempt to match the order
    await this.matchingEngine.processOrder(order);

    // Broadcast order book update
    this.emitOrderBookUpdated(request.donutTypeId);

    // Return the updated order
    return await this.orderRepo.findById(order.orderId) || order;
  }

  async getOrder(orderId: string): Promise<Order | null> {
    return await this.orderRepo.findById(orderId);
  }

  async getOrderBook(donutTypeId: string, includeAll: boolean = false): Promise<OrderBook> {
    return await this.orderRepo.getOrderBook(donutTypeId, includeAll);
  }

  // ==========================================
  // Transaction History
  // ==========================================

  async getTransactionsByDonutType(donutTypeId: string, limit?: number): Promise<Transaction[]> {
    return await this.transactionRepo.findByDonutType(donutTypeId, limit);
  }

  async getRecentTransactions(limit?: number): Promise<Transaction[]> {
    return await this.transactionRepo.findRecent(limit);
  }

  async getTransaction(transactionId: string): Promise<Transaction | null> {
    return await this.transactionRepo.findById(transactionId);
  }

  // ==========================================
  // Outlet Management
  // ==========================================

  async createOutlet(outlet: Omit<Outlet, 'createdAt'>): Promise<Outlet> {
    return await this.outletRepo.create(outlet);
  }

  async getOutlet(outletId: string): Promise<Outlet | null> {
    return await this.outletRepo.findById(outletId);
  }

  async getAllOutlets(): Promise<Outlet[]> {
    const outlets = await this.outletRepo.findAll();
    // Filter out the supplier factory - it's internal infrastructure, not a retail outlet
    return outlets.filter(o => o.outletId !== 'supplier-factory');
  }

  async getFactory(): Promise<Outlet | null> {
    return await this.outletRepo.findById('supplier-factory');
  }

  async toggleFactoryOpen(isOpen: boolean): Promise<void> {
    await this.outletRepo.toggleOpen('supplier-factory', isOpen);
  }

  // ==========================================
  // Donut Type Management
  // ==========================================

  async createDonutType(donutType: DonutType): Promise<DonutType> {
    return await this.donutTypeRepo.create(donutType);
  }

  async getDonutType(donutTypeId: string): Promise<DonutType | null> {
    return await this.donutTypeRepo.findById(donutTypeId);
  }

  async getAllDonutTypes(): Promise<DonutType[]> {
    return await this.donutTypeRepo.findAll();
  }

  // ==========================================
  // Retail Operations
  // ==========================================

  async updateOutletMargin(outletId: string, marginPercent: number): Promise<void> {
    await this.outletRepo.updateMargin(outletId, marginPercent);
  }

  async toggleOutletOpen(outletId: string, isOpen: boolean): Promise<void> {
    await this.outletRepo.toggleOpen(outletId, isOpen);
  }

  async toggleAllOutletsOpen(isOpen: boolean): Promise<void> {
    await this.outletRepo.toggleAllOpen(isOpen);
  }

  getOutletInventory(outletId: string, donutTypeId: string): number {
    return this.getInventoryFromCache(outletId, donutTypeId);
  }

  getAllOutletInventory(outletId: string): Map<string, number> {
    return this.inventoryCache.get(outletId) || new Map();
  }

  async sellToCustomer(outletId: string, donutTypeId: string, quantity: number): Promise<CustomerSale> {
    const outlet = await this.outletRepo.findById(outletId);
    if (!outlet) {
      throw new Error('Outlet not found');
    }

    // Check inventory from cache
    const available = this.getInventoryFromCache(outletId, donutTypeId);
    if (available < quantity) {
      throw new Error(`Insufficient inventory: ${available} ${donutTypeId} available, ${quantity} requested`);
    }

    // Remove from inventory (persisted to DB)
    await this.removeInventory(outletId, donutTypeId, quantity);

    // Simplified: assume outlet bought donuts at $2/unit on the exchange
    // In reality, we'd track actual inventory cost basis
    const costBasis = 2.0 * quantity;
    const revenue = costBasis * (1 + outlet.marginPercent / 100);
    const profit = revenue - costBasis;

    // Update outlet balance (they receive cash from customer)
    await this.outletRepo.updateBalance(outletId, outlet.balance + revenue);

    // Track customer sales stats
    const stats = this.getOrCreateStats(outletId);
    stats.customerSalesRevenue += revenue;
    stats.customerSalesCount += 1;

    console.log(`🛒 Customer Sale: ${outlet.outletName} sold ${quantity} ${donutTypeId} donuts (${available - quantity} remaining)`);
    console.log(`   Cost: $${costBasis.toFixed(2)}, Revenue: $${revenue.toFixed(2)}, Profit: $${profit.toFixed(2)} (${outlet.marginPercent}% margin)`);

    // Create and persist sale record
    const sale: CustomerSale = {
      saleId: `sale-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      outletId,
      donutTypeId,
      quantity,
      costBasis,
      revenue,
      profit,
      executedAt: new Date()
    };

    // Persist to DB (fire and forget to not slow down sales)
    this.customerSaleRepo.create(sale).catch(err => {
      console.error('Error persisting customer sale:', err);
    });

    return sale;
  }

  async getOutletStats(outletId: string): Promise<OutletStats> {
    const outlet = await this.outletRepo.findById(outletId);
    if (!outlet) {
      throw new Error('Outlet not found');
    }

    const stats = this.getOrCreateStats(outletId);
    const netProfit = outlet.balance - 10000; // Starting balance was 10000

    return {
      outletId: outlet.outletId,
      outletName: outlet.outletName,
      balance: outlet.balance,
      customerSalesRevenue: stats.customerSalesRevenue,
      customerSalesCount: stats.customerSalesCount,
      exchangeSalesRevenue: stats.exchangeSalesRevenue,
      exchangeSalesCount: stats.exchangeSalesCount,
      netProfit,
      averageMargin: outlet.marginPercent
    };
  }

  async getLeaderboard(): Promise<OutletStats[]> {
    const outlets = await this.outletRepo.findAll();

    // Filter out the supplier factory - it's not a competing outlet
    const retailOutlets = outlets.filter(o => o.outletId !== 'supplier-factory');

    const leaderboard = retailOutlets.map(outlet => {
      const stats = this.getOrCreateStats(outlet.outletId);
      const netProfit = outlet.balance - 10000; // Starting balance was 10000
      return {
        outletId: outlet.outletId,
        outletName: outlet.outletName,
        balance: outlet.balance,
        customerSalesRevenue: stats.customerSalesRevenue,
        customerSalesCount: stats.customerSalesCount,
        exchangeSalesRevenue: stats.exchangeSalesRevenue,
        exchangeSalesCount: stats.exchangeSalesCount,
        netProfit,
        averageMargin: outlet.marginPercent
      };
    });

    // Sort by profit descending
    return leaderboard.sort((a, b) => b.netProfit - a.netProfit);
  }
}
