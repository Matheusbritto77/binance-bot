const aiModule = require('../aiModule');

describe('aiModule.js - Funções principais', () => {
  it('init executa sem erros', async () => {
    await expect(aiModule.init()).resolves.toBeUndefined();
  });

  it('collectData executa sem erros', () => {
    expect(() => aiModule.collectData('BTCUSDT', '1m', { close: 100 }, { rsi: 50 })).not.toThrow();
  });

  it('train executa sem erros', async () => {
    await expect(aiModule.train()).resolves.toBeUndefined();
  });

  it('predict retorna null ou objeto', async () => {
    const result = await aiModule.predict('BTCUSDT', '1m', [{ close: 100 }]);
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('predictExit retorna null ou objeto', async () => {
    const result = await aiModule.predictExit('BTCUSDT', '1m', [{ close: 100 }], { entryPrice: 100, side: 'LONG' });
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('isReadyForTrading retorna boolean', () => {
    expect(typeof aiModule.isReadyForTrading()).toBe('boolean');
  });

  it('getCollectedDataCount retorna número', () => {
    expect(typeof aiModule.getCollectedDataCount('BTCUSDT', '1m')).toBe('number');
  });

  it('collectHistoricalDataFromHttp executa sem erros', () => {
    expect(() => aiModule.collectHistoricalDataFromHttp('BTCUSDT', '1m', [{ close: 100 }])).not.toThrow();
  });
}); 