const dataHttp = require('../dataHttp');

describe('dataHttp.js - Funções principais', () => {
  it('setBinanceClient executa sem erros', () => {
    expect(() => dataHttp.setBinanceClient({})).not.toThrow();
  });

  it('getHistoricalData retorna null se client não definido', async () => {
    const result = await dataHttp.getHistoricalData('BTCUSDT', '1m');
    expect(result).toBeNull();
  });
}); 