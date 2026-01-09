// Simplified OrderRepository for initial TypeDB 3.x HTTP API integration
// TODO: Implement full order book queries and matching logic

import { TypeDBConnection } from '../config/typedb.js';
import { TransactionHelper } from '../config/transaction-helper.js';
import { Order, OrderSide, OrderStatus, OrderBook, OrderBookEntry } from '../models/types.js';

function parseStatus(status: string): OrderStatus {
  return status as OrderStatus;
}

export class OrderRepository {
  private connection: TypeDBConnection;
  private helper: TransactionHelper | null = null;

  constructor() {
    this.connection = TypeDBConnection.getInstance();
  }

  private getHelper(): TransactionHelper {
    if (!this.helper) {
      const driver = this.connection.getDriver();
      const dbName = this.connection.getDatabaseName();
      this.helper = new TransactionHelper(driver, dbName);
    }
    return this.helper;
  }

  // Format datetime for TypeDB 3.x (without timezone for 'datetime' type)
  private formatDateTime(date: Date): string {
    return date.toISOString().replace('Z', '');
  }

  async create(order: Omit<Order, 'orderId' | 'createdAt' | 'updatedAt' | 'status'>): Promise<Order> {
    const orderId = `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = this.formatDateTime(new Date());
    const orderType = order.side === OrderSide.BUY ? 'buy-order' : 'sell-order';

    const queries = [
      `insert $order isa ${orderType}, has order-id "${orderId}", has quantity ${order.quantity}, has price-per-unit ${order.pricePerUnit}, has status "${OrderStatus.ACTIVE}", has created-at ${now}, has updated-at ${now};`,
      `match $order isa order, has order-id "${orderId}"; $outlet isa outlet, has outlet-id "${order.outletId}"; insert $placement isa order-placement, has donut-type-id "${order.donutTypeId}"; $placement links (placer: $outlet, order: $order);`
    ];

    await this.getHelper().executeTransaction(queries);

    return {
      orderId,
      side: order.side,
      donutTypeId: order.donutTypeId,
      quantity: order.quantity,
      pricePerUnit: order.pricePerUnit,
      status: OrderStatus.ACTIVE,
      outletId: order.outletId,
      createdAt: new Date(now),
      updatedAt: new Date(now)
    };
  }

  async findById(orderId: string): Promise<Order | null> {
    const helper = this.getHelper();

    const query = `
      match
        $order isa order,
          has order-id "${orderId}";
        $placement isa order-placement,
          links (placer: $outlet, order: $order),
          has donut-type-id $donut_type;
      fetch {
        "orderId": $order.order-id,
        "outletId": $outlet.outlet-id,
        "quantity": $order.quantity,
        "pricePerUnit": $order.price-per-unit,
        "status": $order.status,
        "createdAt": $order.created-at,
        "updatedAt": $order.updated-at,
        "donutTypeId": $donut_type
      };
    `;

    try {
      const response = await helper.executeReadQuery(query);

      if (response.answerType === 'conceptDocuments' && (response.answers as any[]).length > 0) {
        const doc = (response.answers as any[])[0];

        // Determine order side from the type
        const sideQuery = `match $o isa sell-order, has order-id "${orderId}"; fetch { "exists": true };`;
        const sideResponse = await helper.executeReadQuery(sideQuery);
        const side = (sideResponse.answerType === 'conceptDocuments' && (sideResponse.answers as any[]).length > 0)
          ? OrderSide.SELL
          : OrderSide.BUY;

        return {
          orderId: doc.orderId,
          side,
          donutTypeId: doc.donutTypeId,
          outletId: doc.outletId,
          quantity: doc.quantity,
          pricePerUnit: doc.pricePerUnit,
          status: doc.status as OrderStatus,
          createdAt: new Date(doc.createdAt),
          updatedAt: new Date(doc.updatedAt)
        };
      }

      return null;
    } catch (error) {
      console.error('Error finding order:', error);
      return null;
    }
  }

  async getOrderBook(donutTypeId: string, includeAll: boolean = false): Promise<OrderBook> {
    const helper = this.getHelper();

    // Query sell orders (TypeDB 3.x syntax with 'links')
    // We fetch all and filter client-side since TypeDB OR syntax is complex
    const sellQuery = `
      match
        $order isa sell-order,
          has status $status;
        $placement isa order-placement,
          links (placer: $outlet, order: $order),
          has donut-type-id "${donutTypeId}";
      fetch {
        "orderId": $order.order-id,
        "outletId": $outlet.outlet-id,
        "quantity": $order.quantity,
        "pricePerUnit": $order.price-per-unit,
        "status": $status,
        "createdAt": $order.created-at
      };
    `;

    // Query buy orders (TypeDB 3.x syntax with 'links')
    const buyQuery = `
      match
        $order isa buy-order,
          has status $status;
        $placement isa order-placement,
          links (placer: $outlet, order: $order),
          has donut-type-id "${donutTypeId}";
      fetch {
        "orderId": $order.order-id,
        "outletId": $outlet.outlet-id,
        "quantity": $order.quantity,
        "pricePerUnit": $order.price-per-unit,
        "status": $status,
        "createdAt": $order.created-at
      };
    `;

    try {
      const [sellResponse, buyResponse] = await Promise.all([
        helper.executeReadQuery(sellQuery),
        helper.executeReadQuery(buyQuery)
      ]);

      const sellOrders: OrderBookEntry[] = [];
      const buyOrders: OrderBookEntry[] = [];

      if (sellResponse.answerType === 'conceptDocuments') {
        for (const doc of sellResponse.answers as any[]) {
          sellOrders.push({
            orderId: doc.orderId,
            outletId: doc.outletId,
            quantity: doc.quantity,
            pricePerUnit: doc.pricePerUnit,
            status: parseStatus(doc.status),
            createdAt: new Date(doc.createdAt)
          });
        }
      }

      if (buyResponse.answerType === 'conceptDocuments') {
        for (const doc of buyResponse.answers as any[]) {
          buyOrders.push({
            orderId: doc.orderId,
            outletId: doc.outletId,
            quantity: doc.quantity,
            pricePerUnit: doc.pricePerUnit,
            status: parseStatus(doc.status),
            createdAt: new Date(doc.createdAt)
          });
        }
      }

      // Filter by status if not including all
      // 'active' and 'partially_filled' are matchable orders
      const isMatchable = (status: OrderStatus) =>
        status === OrderStatus.ACTIVE || status === OrderStatus.PARTIALLY_FILLED;

      const filteredSellOrders = includeAll
        ? sellOrders
        : sellOrders.filter(o => isMatchable(o.status));
      const filteredBuyOrders = includeAll
        ? buyOrders
        : buyOrders.filter(o => isMatchable(o.status));

      // Sort by time descending (newest first) for display
      filteredSellOrders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      filteredBuyOrders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      return { donutTypeId, buyOrders: filteredBuyOrders, sellOrders: filteredSellOrders };
    } catch (error) {
      console.error('Error fetching order book:', error);
      return { donutTypeId, buyOrders: [], sellOrders: [] };
    }
  }

  async updateStatus(orderId: string, status: OrderStatus): Promise<void> {
    const now = this.formatDateTime(new Date());
    const query = `
      match
      $order isa order, has order-id "${orderId}";
      update
      $order has status "${status}", has updated-at ${now};
    `;

    await this.getHelper().executeWriteQuery(query);
  }

  async updateQuantity(orderId: string, newQuantity: number): Promise<void> {
    const now = this.formatDateTime(new Date());
    const query = `
      match
      $order isa order, has order-id "${orderId}";
      update
      $order has quantity ${newQuantity}, has updated-at ${now};
    `;

    await this.getHelper().executeWriteQuery(query);
  }
}
