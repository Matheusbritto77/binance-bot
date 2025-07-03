const rewire = require('rewire');
const index = rewire('../index');

describe('index.js - Funções principais', () => {
  const symbol = 'BTCUSDT';
  const timeframe = '1m';
  const mockSignal = {
    side: 'LONG',
    strategy: 'TrendFollowing',
    config: {
      stopLossPercent: 1,
      takeProfitPercent: 2,
      maxOperationDurationMinutes: 60
    }
  };
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runMasterStrategy executa sem erros com mocks', async () => {
    const allTimeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
    global.STRATEGY_CONFIG = { timeframesToWatch: ['1m', '5m'], strategies: { trendFollowing: { enabled: false }, meanReversion: { enabled: false }, breakout: { enabled: false } }, aiModule: { enabled: false } };
    const data = {};
    for (const tf of allTimeframes) {
      data[tf] = {
        candles: Array(200).fill({ close: 100 }),
        indicators: { rsi: 50, ema: 100, bb: { lower: 90, upper: 110, middle: 100 }, smaVolume: 100 },
        lastPrice: 100,
      };
    }
    const mockWebsocketService = { getBotState: () => ({ [symbol]: { data, position: { side: 'NONE' } } }) };
    index.__set__('websocketService', mockWebsocketService);
    await expect(index.runMasterStrategy(symbol, '1m')).resolves.toBeUndefined();
  });

  it('manageOpenPosition executa sem erros com mocks', async () => {
    const allTimeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
    global.STRATEGY_CONFIG = { timeframesToWatch: ['1m', '5m'], takerFeePercent: 0.04 };
    const data = {};
    for (const tf of allTimeframes) {
      data[tf] = {
        candles: Array(200).fill({ close: 100 }),
        indicators: { rsi: 50, ema: 100, bb: { lower: 90, upper: 110, middle: 100 }, smaVolume: 100 },
        lastPrice: 100,
      };
    }
    const mockWebsocketService = { getBotState: () => ({ [symbol]: { data, position: { side: 'LONG', entryPrice: 100, quantity: 1, activeStrategy: 'TrendFollowing', activeStrategyConfig: { takeProfitPercent: 1, stopLossPercent: 1, useInvalidationExit: false }, openTime: Date.now() - 1000, maxDurationMs: 60000, trailingActive: false } } }) };
    index.__set__('websocketService', mockWebsocketService);
    global.exchangeRules = { [symbol]: { quantityPrecision: 3 } };
    await expect(index.manageOpenPosition(symbol, '1m')).resolves.toBeUndefined();
  });

  it('openPosition executa sem erros com mocks', async () => {
    const mockWebsocketService = { getBotState: () => ({ [symbol]: { data: { [timeframe]: { lastPrice: 10000, candles: [{ close: 10000 }], indicators: {} } }, position: { side: 'NONE' } } }) };
    const mockOrder = { executedQty: '0.001', orderId: 123 };
    const mockClient = {
      futuresOrder: jest.fn().mockResolvedValue(mockOrder),
      futuresAccountInfo: jest.fn().mockResolvedValue({ assets: [{ asset: 'USDT', availableBalance: '100' }] }),
      futuresUserTrades: jest.fn().mockResolvedValue([{ commission: '0.01', price: '10000' }])
    };
    const mockExchangeRules = { [symbol]: { quantityPrecision: 3 } };
    const mockGetUSDTBalanceFromUserData = () => 100;
    global.STRATEGY_CONFIG = { leverage: 1, marginPercentPerTrade: 10, quoteAsset: 'USDT', takerFeePercent: 0.04, timeframesToWatch: [timeframe] };
    global.userOrders = {};
    index.__set__('client', mockClient);
    index.__set__('websocketService', mockWebsocketService);
    index.__set__('exchangeRules', mockExchangeRules);
    index.__set__('getUSDTBalanceFromUserData', mockGetUSDTBalanceFromUserData);
    await expect(index.openPosition(symbol, mockSignal)).resolves.toBeUndefined();
  });

  it('openPosition lida com erro de API', async () => {
    const mockWebsocketService = { getBotState: () => ({ [symbol]: { data: { [timeframe]: { lastPrice: 10000, candles: [{ close: 10000 }], indicators: {} } }, position: { side: 'NONE' } } }) };
    const mockClient = {
      futuresOrder: jest.fn().mockRejectedValue(new Error('API error')),
      futuresAccountInfo: jest.fn(),
      futuresUserTrades: jest.fn()
    };
    const mockExchangeRules = { [symbol]: { quantityPrecision: 3 } };
    const mockGetUSDTBalanceFromUserData = () => 100;
    global.STRATEGY_CONFIG = { leverage: 1, marginPercentPerTrade: 10, quoteAsset: 'USDT', takerFeePercent: 0.04, timeframesToWatch: [timeframe] };
    global.userOrders = {};
    index.__set__('client', mockClient);
    index.__set__('websocketService', mockWebsocketService);
    index.__set__('exchangeRules', mockExchangeRules);
    index.__set__('getUSDTBalanceFromUserData', mockGetUSDTBalanceFromUserData);
    await expect(index.openPosition(symbol, mockSignal)).resolves.toBeUndefined();
  });
}); 