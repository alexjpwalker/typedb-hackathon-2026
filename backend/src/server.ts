import express, { Express } from 'express';
import cors from 'cors';
import { createServer, Server as HTTPServer } from 'http';
import { TypeDBConnection } from './config/typedb.js';
import { ExchangeService } from './services/ExchangeService.js';
import { CustomerSimulator } from './services/CustomerSimulator.js';
import { DonutSupplier } from './services/DonutSupplier.js';
import { PurchasingAgent } from './services/PurchasingAgent.js';
import { createRoutes } from './api/routes.js';
import { WebSocketManager } from './api/websocket.js';

const PORT = process.env.PORT || 3000;

class DonutExchangeServer {
  private app: Express;
  private server: HTTPServer;
  private connection: TypeDBConnection;
  private exchangeService: ExchangeService;
  private customerSimulator: CustomerSimulator;
  private donutSupplier: DonutSupplier;
  private purchasingAgent: PurchasingAgent;
  private wsManager: WebSocketManager | null = null;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.connection = TypeDBConnection.getInstance();
    this.exchangeService = new ExchangeService();
    this.customerSimulator = new CustomerSimulator(this.exchangeService);
    this.donutSupplier = new DonutSupplier(this.exchangeService);
    this.purchasingAgent = new PurchasingAgent(this.exchangeService);

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // CORS
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true
    }));

    // JSON parsing
    this.app.use(express.json());

    // Request logging
    this.app.use((req, _res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    const routes = createRoutes(this.exchangeService);
    this.app.use('/api', routes);

    // Root endpoint
    this.app.get('/', (_req, res) => {
      res.json({
        name: 'Donut Exchange API',
        version: '1.0.0',
        endpoints: {
          health: '/api/health',
          donutTypes: '/api/donut-types',
          outlets: '/api/outlets',
          orders: '/api/orders',
          orderBook: '/api/order-book/:donutTypeId',
          transactions: '/api/transactions',
          websocket: 'ws://localhost:' + PORT + '/ws'
        }
      });
    });
  }

  async start(): Promise<void> {
    try {
      console.log('Starting Donut Exchange Server...');

      // Connect to TypeDB
      console.log('Connecting to TypeDB...');
      await this.connection.connect();

      // Start exchange service
      console.log('Starting exchange service...');
      await this.exchangeService.start();

      // Start WebSocket server
      console.log('Starting WebSocket server...');
      this.wsManager = new WebSocketManager(this.server);

      // Connect customer simulator to WebSocket for broadcasting events
      this.customerSimulator.onCustomerEvent((event) => {
        // Only broadcast purchase events to reduce noise (arrivals/visits are too frequent)
        if (event.eventType === 'customer_purchased') {
          this.wsManager?.notifyCustomerEvent(event);
        }
        // Log all events to console
        console.log(`[Customer] ${event.message}`);
      });

      // Connect matching engine errors to WebSocket
      this.exchangeService.onMatchingError((message, source) => {
        this.wsManager?.notifyError(message, source);
      });

      // Connect order book updates to WebSocket
      this.exchangeService.onOrderBookUpdated((orderBook) => {
        this.wsManager?.notifyOrderBookUpdated(orderBook);
      });

      // Start donut supplier (factory)
      console.log('Starting donut supplier...');
      await this.donutSupplier.start();

      // Start purchasing agent
      console.log('Starting purchasing agent...');
      await this.purchasingAgent.start();

      // Start customer simulator
      console.log('Starting customer simulator...');
      await this.customerSimulator.start();

      // Start HTTP server
      this.server.listen(PORT, () => {
        console.log('');
        console.log('='.repeat(60));
        console.log('🍩  Donut Exchange Server is running!');
        console.log('='.repeat(60));
        console.log(`📡  HTTP API: http://localhost:${PORT}`);
        console.log(`🔌  WebSocket: ws://localhost:${PORT}/ws`);
        console.log(`📊  Health: http://localhost:${PORT}/api/health`);
        console.log(`🏭  Donut Supplier: ACTIVE (factory supplies every 5s)`);
        console.log(`🛒  Purchasing Agent: ACTIVE (outlets auto-buy)`);
        console.log(`👥  Customer Simulator: ACTIVE (1-10 customers/sec)`);
        console.log('='.repeat(60));
        console.log('');
      });

      // Graceful shutdown handlers
      process.on('SIGINT', () => this.shutdown('SIGINT'));
      process.on('SIGTERM', () => this.shutdown('SIGTERM'));

    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  private async shutdown(signal: string): Promise<void> {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    try {
      // Stop customer simulator
      this.customerSimulator.stop();

      // Stop purchasing agent
      this.purchasingAgent.stop();

      // Stop donut supplier
      this.donutSupplier.stop();

      // Close WebSocket connections
      if (this.wsManager) {
        this.wsManager.close();
      }

      // Stop exchange service
      await this.exchangeService.stop();

      // Close TypeDB connection
      await this.connection.close();

      // Close HTTP server
      this.server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });

      // Force close after 10 seconds
      setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);

    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  }
}

// Start the server
const server = new DonutExchangeServer();
server.start();
