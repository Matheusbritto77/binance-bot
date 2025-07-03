const log = require('../log');
const index = require('../index');

jest.mock('../log');

function getMockBotState({ trailingActive = false, closeReason = null, now = Date.now(), openTime = null, maxDurationMs = null, trailingStopPrice = null, side = 'LONG', activeStrategy = 'MeanReversion', indicators = {}, rsi = 50 }) {
  return {
    TESTUSDT: {
      position: {
        side,
        entryPrice: 100,
        quantity: 1,
        activeStrategy,
        activeStrategyConfig: {
          takeProfitPercent: 2,
          stopLossPercent: 1,
          useInvalidationExit: true,
          trailingStopPercent: 0.5
        },
        openTime: openTime || now - 10 * 60 * 1000,
        maxDurationMs: maxDurationMs || 15 * 60 * 1000,
        trailingActive,
        trailingStopPrice: trailingStopPrice || 99,
      },
      data: {
        '1m': {
          lastPrice: 98,
          indicators: { ...indicators, rsi },
          candles: [{ volume: 1000 }]
        }
      }
    }
  };
}

describe('Gerenciamento Avançado - Logs Detalhados', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    index.websocketService.getBotState = jest.fn();
  });

  it('deve logar ativação e movimentação do trailing stop', async () => {
    const now = Date.now();
    // Ativação
    index.websocketService.getBotState.mockReturnValue(getMockBotState({ trailingActive: false, now, trailingStopPrice: 97, indicators: { bb: { middle: 97 } } }));
    await index.manageOpenPosition('TESTUSDT', '1m');
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('[TRAILING] [TESTUSDT] Ativado!'));
    // Movimentação
    index.websocketService.getBotState.mockReturnValue(getMockBotState({ trailingActive: true, now, trailingStopPrice: 97, indicators: { bb: { middle: 98 } } }));
    await index.manageOpenPosition('TESTUSDT', '1m');
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('[TRAILING] [TESTUSDT] Movido!'));
  });

  it('deve logar fechamento por tempo máximo', async () => {
    const now = Date.now();
    index.websocketService.getBotState.mockReturnValue(getMockBotState({ openTime: now - 20 * 60 * 1000, maxDurationMs: 15 * 60 * 1000 }));
    await index.manageOpenPosition('TESTUSDT', '1m');
    expect(log).toHaveBeenCalledWith('warning', expect.stringContaining('Fechando por tempo máximo'));
  });

  it('deve logar fechamento por decisão da IA', async () => {
    const now = Date.now();
    // Simula closeReason AI_EXIT_SIGNAL
    const botState = getMockBotState({ now });
    index.websocketService.getBotState.mockReturnValue(botState);
    // Mock da IA para forçar closeReason
    index.aiModule = { predictExit: jest.fn().mockResolvedValue({ action: 'CLOSE', reason: 'AI' }) };
    await index.manageOpenPosition('TESTUSDT', '1m');
    expect(log).toHaveBeenCalledWith('warning', expect.stringContaining('Fechando por decisão da IA'));
  });

  it('deve logar fechamento por indicador', async () => {
    const now = Date.now();
    // Simula closeReason customizado
    const botState = getMockBotState({ now });
    index.websocketService.getBotState.mockReturnValue(botState);
    // Força closeReason customizado
    index.aiModule = { predictExit: jest.fn().mockResolvedValue(null) };
    // Manipula para forçar closeReason
    botState.TESTUSDT.position.activeStrategyConfig = { ...botState.TESTUSDT.position.activeStrategyConfig, useInvalidationExit: true };
    botState.TESTUSDT.data['1m'].indicators.rsi = 80; // Força RSI_OVERBOUGHT_CLOSE
    await index.manageOpenPosition('TESTUSDT', '1m');
    expect(log).toHaveBeenCalledWith('warning', expect.stringContaining('Fechando por indicador'));
  });
}); 