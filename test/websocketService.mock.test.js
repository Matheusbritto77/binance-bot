const log = require('../log');
const websocketService = require('../websocketService');

jest.mock('../log');

describe('WebSocketService - MANAGEMENT_ONLY', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deve assinar apenas ativos com posição aberta no modo MANAGEMENT_ONLY', async () => {
    const initialBotState = {
      BTCUSDT: { position: { side: 'LONG' } },
      ETHUSDT: { position: { side: 'NONE' } },
      ADAUSDT: { position: { side: 'SHORT' } }
    };
    global.tradingMode = 'MANAGEMENT_ONLY';
    const STRATEGY_CONFIG = { symbolsToWatch: ['BTCUSDT', 'ETHUSDT', 'ADAUSDT'], timeframesToWatch: ['1m'] };
    websocketService.STRATEGY_CONFIG = STRATEGY_CONFIG;
    // Mock streams para capturar quais símbolos são assinados
    const streams = [];
    const oldPush = Array.prototype.push;
    Array.prototype.push = function(...args) { streams.push(...args); return oldPush.apply(this, args); };
    await websocketService.initialize({}, initialBotState, () => {});
    Array.prototype.push = oldPush;
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('assinando apenas ativos com posição aberta: BTCUSDT, ADAUSDT'));
    expect(streams.some(s => s.includes('BTCUSDT'))).toBe(true);
    expect(streams.some(s => s.includes('ADAUSDT'))).toBe(true);
    expect(streams.some(s => s.includes('ETHUSDT'))).toBe(false);
  });

  it('deve assinar todos os ativos no modo normal', async () => {
    const initialBotState = {
      BTCUSDT: { position: { side: 'LONG' } },
      ETHUSDT: { position: { side: 'NONE' } },
      ADAUSDT: { position: { side: 'SHORT' } }
    };
    global.tradingMode = 'FULL_TRADING';
    const STRATEGY_CONFIG = { symbolsToWatch: ['BTCUSDT', 'ETHUSDT', 'ADAUSDT'], timeframesToWatch: ['1m'] };
    websocketService.STRATEGY_CONFIG = STRATEGY_CONFIG;
    const streams = [];
    const oldPush = Array.prototype.push;
    Array.prototype.push = function(...args) { streams.push(...args); return oldPush.apply(this, args); };
    await websocketService.initialize({}, initialBotState, () => {});
    Array.prototype.push = oldPush;
    expect(streams.some(s => s.includes('BTCUSDT'))).toBe(true);
    expect(streams.some(s => s.includes('ADAUSDT'))).toBe(true);
    expect(streams.some(s => s.includes('ETHUSDT'))).toBe(true);
  });
}); 