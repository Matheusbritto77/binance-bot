const websocketService = require('../websocketService');

describe('websocketService.js - Funções principais', () => {
  it('getBotState retorna objeto', () => {
    const state = websocketService.getBotState();
    expect(typeof state).toBe('object');
  });

  it('initialize executa sem erros com mocks', async () => {
    const mockClient = {};
    const initialBotState = { BTCUSDT: { data: {}, position: { side: 'NONE' } } };
    const onCandleReceived = jest.fn();
    await expect(websocketService.initialize(mockClient, initialBotState, onCandleReceived)).resolves.toBeDefined();
  });

  it('MIN_CANDLES_FOR_FULL_INDICATORS é um número', () => {
    expect(typeof websocketService.MIN_CANDLES_FOR_FULL_INDICATORS).toBe('number');
  });
}); 