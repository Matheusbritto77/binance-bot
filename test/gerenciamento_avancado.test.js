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

const symbol = 'BTCUSDT';
const timeframe = '1m';

function mockState({side = 'LONG', strategy = 'TrendFollowing', price = 100, ema = 98, bb = {lower: 95, upper: 105, middle: 100}, openTime = Date.now() - 1000 * 60 * 59, maxDuration = 60*60*1000, trailingActive = false, trailingStopPrice = null, rsi = 50}) {
  const timeframes = STRATEGY_CONFIG.timeframesToWatch;
  const data = {};
  for (const tf of timeframes) {
    data[tf] = {
      candles: Array(MIN_CANDLES_FOR_FULL_INDICATORS).fill().map((_, i) => ({
        open: price, high: price+5, low: price-5, close: price, volume: 100, openTime: i, isFinal: true
      })),
      indicators: { rsi, ema, bb, smaVolume: 100 },
      lastPrice: price,
      isReady: true
    };
  }
  return {
    data,
    position: {
      side,
      entryPrice: 100,
      quantity: 1,
      activeStrategy: strategy,
      activeStrategyConfig: {
        takeProfitPercent: 5,
        stopLossPercent: 2.5,
        useInvalidationExit: true,
        maxOperationDurationMinutes: 60,
        trailingStopPercent: 0.5
      },
      openTime,
      maxDurationMs: maxDuration,
      trailingActive,
      trailingStopPrice
    }
  };
}

describe('Gerenciamento avançado', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fecha por tempo máximo', async () => {
    websocketService.setMockBotState({ [symbol]: mockState({ openTime: Date.now() - 61*60*1000 }) });
    const closePosition = jest.spyOn(index, 'closePosition').mockImplementation(async () => {});
    await index.manageOpenPosition(symbol, timeframe);
    expect(closePosition).toHaveBeenCalledWith(symbol, 'MAX_DURATION_REACHED');
  });

  it('ativa e move trailing stop baseado em EMA (TrendFollowing)', async () => {
    websocketService.setMockBotState({ [symbol]: mockState({ strategy: 'TrendFollowing', price: 110, ema: 108, trailingActive: false }) });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await index.manageOpenPosition(symbol, timeframe);
    expect(websocketService.getBotState()[symbol].position.trailingActive).toBe(true);
    expect(websocketService.getBotState()[symbol].position.trailingStopPrice).toBe(108);
    logSpy.mockRestore();
  });

  it('fecha por trailing stop atingido', async () => {
    websocketService.setMockBotState({ [symbol]: mockState({ strategy: 'TrendFollowing', price: 107, ema: 108, trailingActive: true, trailingStopPrice: 108 }) });
    const closePosition = jest.spyOn(index, 'closePosition').mockImplementation(async () => {});
    await index.manageOpenPosition(symbol, timeframe);
    expect(closePosition).toHaveBeenCalledWith(symbol, 'TRAILING_STOP_HIT');
  });

  it('fecha por indicador ao final do tempo (RSI)', async () => {
    websocketService.setMockBotState({ [symbol]: mockState({ rsi: 80, openTime: Date.now() - 0.96*60*60*1000 }) });
    const closePosition = jest.spyOn(index, 'closePosition').mockImplementation(async () => {});
    await index.manageOpenPosition(symbol, timeframe);
    expect(closePosition).toHaveBeenCalledWith(symbol, 'RSI_OVERBOUGHT_CLOSE');
  });
}); 