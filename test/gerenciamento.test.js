jest.mock('../websocketService', () => {
  const STRATEGY_CONFIG = require('../config.json');
  const MIN_CANDLES_FOR_FULL_INDICATORS = Math.max(
    STRATEGY_CONFIG.strategies.trendFollowing.emaPeriod || 200,
    STRATEGY_CONFIG.strategies.trendFollowing.rsiPeriod || 14,
    STRATEGY_CONFIG.strategies.meanReversion.bollingerPeriod || 20,
    STRATEGY_CONFIG.strategies.breakout?.volumeSmaPeriod || 20
  );
  let botState = {};
  return {
    getBotState: () => botState,
    setMockBotState: (state) => { botState = state; },
    MIN_CANDLES_FOR_FULL_INDICATORS
  };
});

const index = require('../index');
const websocketService = require('../websocketService');
const STRATEGY_CONFIG = require('../config.json');
const { MIN_CANDLES_FOR_FULL_INDICATORS } = websocketService;
const rewire = require('rewire');

// Mock do estado do bot e funções auxiliares
const mockBotState = (side = 'NONE') => {
  const timeframes = STRATEGY_CONFIG.timeframesToWatch;
  const data = {};
  for (const tf of timeframes) {
    data[tf] = {
      candles: Array(MIN_CANDLES_FOR_FULL_INDICATORS).fill().map((_, i) => ({
        open: 100, high: 105, low: 95, close: 100, volume: 100, openTime: i, isFinal: true
      })),
      indicators: { rsi: 50, ema: 100, bb: { lower: 90, upper: 110, middle: 100 }, smaVolume: 100 },
      lastPrice: 100,
      isReady: true
    };
  }
  return {
    data,
    position: {
      side,
      entryPrice: 100,
      quantity: 1,
      activeStrategy: 'TrendFollowing',
      activeStrategyConfig: { takeProfitPercent: 1, stopLossPercent: 1, useInvalidationExit: false }
    }
  };
};

describe('Modo de Gerenciamento', () => {
  it('não deve abrir novas posições quando em modo MANAGEMENT_ONLY', async () => {
    global.tradingMode = 'MANAGEMENT_ONLY';
    const symbol = 'BTCUSDT';
    const timeframe = '1m';
    websocketService.setMockBotState({ [symbol]: mockBotState('NONE') });
    const result = await index.runMasterStrategy(symbol, timeframe);
    expect(result).toBeUndefined();
  });
});

describe('Gerenciamento de operações abertas', () => {
  it('deve gerenciar posição aberta mesmo fora do modo MANAGEMENT_ONLY', async () => {
    global.tradingMode = 'FULL_TRADING';
    const symbol = 'BTCUSDT';
    const timeframe = '1m';
    websocketService.setMockBotState({ [symbol]: mockBotState('LONG') });
    const mockManage = jest.fn(async () => {});
    await index.runMasterStrategy(symbol, timeframe, mockManage);
    expect(mockManage).toHaveBeenCalled();
  });
});

describe('Abertura de posição (openPosition)', () => {
  it('deve abrir uma posição corretamente com mocks', async () => {
    const symbol = 'BTCUSDT';
    const signal = {
      side: 'LONG',
      strategy: 'TrendFollowing',
      config: {
        stopLossPercent: 1,
        takeProfitPercent: 2,
        maxOperationDurationMinutes: 60
      }
    };
    // Mock do estado do bot
    const mockBotState = {
      [symbol]: {
        data: {
          '1m': {
            lastPrice: 10000,
            candles: [{ close: 10000 }],
            indicators: {}
          }
        },
        position: { side: 'NONE' }
      }
    };
    // Mock das dependências globais
    const mockWebsocketService = require('../websocketService');
    mockWebsocketService.getBotState = () => mockBotState;
    // Mock do client Binance
    const mockOrder = { executedQty: '0.001', orderId: 123 };
    const mockClient = {
      futuresOrder: jest.fn().mockResolvedValue(mockOrder),
      futuresAccountInfo: jest.fn().mockResolvedValue({ assets: [{ asset: 'USDT', availableBalance: '100' }] }),
      futuresUserTrades: jest.fn().mockResolvedValue([{ commission: '0.01', price: '10000' }])
    };
    // Mock das regras de exchange
    const mockExchangeRules = { [symbol]: { quantityPrecision: 3 } };
    // Mock do saldo via WebSocket
    const mockGetUSDTBalanceFromUserData = () => 100;
    // Mock do userOrders
    global.userOrders = {};
    // Substitui o client e websocketService no index.js usando rewire
    const index = rewire('../index');
    index.__set__('client', mockClient);
    index.__set__('websocketService', mockWebsocketService);
    index.__set__('exchangeRules', mockExchangeRules);
    index.__set__('getUSDTBalanceFromUserData', mockGetUSDTBalanceFromUserData);
    // Executa a função
    await index.openPosition(symbol, signal);
    // Verifica se as funções do client foram chamadas corretamente
    expect(mockClient.futuresOrder).toHaveBeenCalled();
    expect(mockClient.futuresAccountInfo).not.toHaveBeenCalled(); // saldo já mockado
    // Verifica se o estado da posição foi atualizado
    expect(mockBotState[symbol].position.side).toBe('LONG');
    expect(mockBotState[symbol].position.quantity).toBeCloseTo(0.001);
    expect(mockBotState[symbol].position.activeStrategy).toBe('TrendFollowing');
    expect(mockBotState[symbol].position.entryPrice).toBe(10000);
  });
}); 