const rewire = require('rewire');
const index = rewire('../index');

describe('INTEGRAÇÃO - Fluxo real simulado COMPLEXO', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT'];
  const timeframes = ['1m', '5m'];
  const allTimeframes = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const strategies = ['TrendFollowing', 'MeanReversion', 'Breakout', 'AI_Prediction'];
  const mockSignals = {
    TrendFollowing: {
      side: 'LONG',
      strategy: 'TrendFollowing',
      config: { stopLossPercent: 1, takeProfitPercent: 2, maxOperationDurationMinutes: 60 }
    },
    MeanReversion: {
      side: 'SHORT',
      strategy: 'MeanReversion',
      config: { stopLossPercent: 1, takeProfitPercent: 2, maxOperationDurationMinutes: 30 }
    },
    Breakout: {
      side: 'LONG',
      strategy: 'Breakout',
      config: { stopLossPercent: 1.5, takeProfitPercent: 3, maxOperationDurationMinutes: 20 }
    },
    AI_Prediction: {
      side: 'LONG',
      strategy: 'AI_Prediction',
      config: { stopLossPercent: 1, takeProfitPercent: 2, maxOperationDurationMinutes: 60, useInvalidationExit: true }
    }
  };

  beforeAll(() => {
    global.STRATEGY_CONFIG = {
      timeframesToWatch: timeframes,
      strategies: {
        trendFollowing: { enabled: true, useInvalidationExit: true, emaPeriod: 200, rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 65, macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }, takeProfitPercent: 5, stopLossPercent: 2.5, maxOperationDurationMinutes: 60 },
        meanReversion: { enabled: true, useInvalidationExit: true, bollingerPeriod: 20, bollingerStdDev: 2, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, takeProfitPercent: 2, stopLossPercent: 1, maxOperationDurationMinutes: 30 },
        breakout: { enabled: true, useInvalidationExit: false, bollingerPeriod: 20, bollingerStdDev: 2, volumeSmaPeriod: 20, takeProfitPercent: 3, stopLossPercent: 1.5, maxOperationDurationMinutes: 20 }
      },
      aiModule: { enabled: true },
      takerFeePercent: 0.04,
      leverage: 1,
      marginPercentPerTrade: 10,
      quoteAsset: 'USDT',
    };
    global.exchangeRules = {};
    for (const s of symbols) global.exchangeRules[s] = { quantityPrecision: 3 };
    global.userOrders = {};
  });

  it('Fluxo completo com múltiplos símbolos, estratégias, IA e erros de API', async () => {
    // Mock do estado do bot para todos os símbolos e timeframes
    const botState = {};
    for (const symbol of symbols) {
      const data = {};
      for (const tf of allTimeframes) {
        data[tf] = {
          candles: Array(200).fill({ close: 100 }),
          indicators: { rsi: 50, ema: 100, bb: { lower: 90, upper: 110, middle: 100 }, smaVolume: 100 },
          lastPrice: 100,
        };
      }
      botState[symbol] = { data, position: { side: 'NONE' } };
    }
    // Mock do websocketService
    const mockWebsocketService = { getBotState: () => botState };
    // Mock do client Binance com erro para um dos símbolos
    const mockOrder = { executedQty: '0.001', orderId: 123 };
    const mockClient = {
      futuresOrder: jest.fn((params) => {
        if (params.symbol === 'ETHUSDT') throw new Error('API error ETHUSDT');
        return Promise.resolve(mockOrder);
      }),
      futuresAccountInfo: jest.fn().mockResolvedValue({ assets: [{ asset: 'USDT', availableBalance: '100' }] }),
      futuresUserTrades: jest.fn().mockResolvedValue([{ commission: '0.01', price: '100' }])
    };
    // Mock do saldo via WebSocket
    const mockGetUSDTBalanceFromUserData = () => 100;
    // Mock IA
    const mockAiModule = {
      isReadyForTrading: () => true,
      predict: jest.fn((symbol, tf, candles) => {
        if (symbol === 'BTCUSDT') return Promise.resolve({ action: 'LONG', confidence: 90 });
        if (symbol === 'ETHUSDT') return Promise.resolve({ action: 'HOLD', confidence: 50 });
        return Promise.resolve(null);
      }),
      predictExit: jest.fn().mockResolvedValue({ action: 'CLOSE', reason: 'TEST', confidence: 99 })
    };
    index.__set__('websocketService', mockWebsocketService);
    index.__set__('client', mockClient);
    index.__set__('exchangeRules', global.exchangeRules);
    index.__set__('getUSDTBalanceFromUserData', mockGetUSDTBalanceFromUserData);
    index.__set__('aiModule', mockAiModule);
    // Para cada símbolo e estratégia, simula o ciclo completo
    for (const symbol of symbols) {
      for (const strat of strategies) {
        // 1. Simula decisão e abertura de posição
        try {
          await index.runMasterStrategy(symbol, timeframes[0]);
        } catch (e) {
          // Esperado para ETHUSDT (erro de API)
          expect(symbol).toBe('ETHUSDT');
        }
        // 2. Simula abertura direta
        try {
          await index.openPosition(symbol, mockSignals[strat]);
        } catch (e) {
          expect(symbol).toBe('ETHUSDT');
        }
        // 3. Simula gerenciamento da posição aberta
        botState[symbol].position.side = mockSignals[strat].side;
        botState[symbol].position.quantity = 0.001;
        botState[symbol].position.activeStrategy = strat;
        botState[symbol].position.activeStrategyConfig = mockSignals[strat].config;
        botState[symbol].position.openTime = Date.now() - 1000;
        botState[symbol].position.maxDurationMs = 60000;
        try {
          await index.manageOpenPosition(symbol, timeframes[0]);
        } catch (e) {
          expect(symbol).toBe('ETHUSDT');
        }
        // Após o gerenciamento, a posição pode ter sido fechada
        expect(['NONE', 'LONG', 'SHORT']).toContain(botState[symbol].position.side);
      }
    }
    // Verifica se as funções do client foram chamadas para BTCUSDT
    expect(mockClient.futuresOrder).toHaveBeenCalled();
    // Verifica se a IA foi chamada
    expect(mockAiModule.predict).toHaveBeenCalled();
    expect(mockAiModule.predictExit).toHaveBeenCalled();
  });
}); 