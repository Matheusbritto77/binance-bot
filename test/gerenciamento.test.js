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