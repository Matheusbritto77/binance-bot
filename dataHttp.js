// =================================================================================================
// dataHttp.js: Módulo para Buscar Dados Históricos via Requisições HTTP
// =================================================================================================
const Binance = require('binance-api-node').default; // Cliente Binance para requisições HTTP
const { RSI, EMA, SMA, BollingerBands } = require('technicalindicators'); // Para calcular indicadores em dados históricos
const fs = require('fs');
const path = require('path');
const log = require('./log');

const STRATEGY_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m" };

// O cliente Binance será passado para este módulo no `main` do bot.js
let binanceClient;

/**
 * Mapeia o timeframe para o limite de velas desejado para dados históricos.
 * Adaptação para cobrir até 7 dias, respeitando o limite de 1500 da API da Binance.
 */
function getRequestedLimit(timeframe) {
    switch(timeframe) {
        // Estes limites visam cobrir aproximadamente 7 dias, mas respeitando o limite de 1500 por requisição.
        // Para mais de 1500 velas, seria necessária uma lógica de paginação/chunking por data.
        case '1m': return 1130; 
        case '5m': return 1130; 
        case '15m': return 1130; 
        case '1h': return 1130;  
        case '4h': return 1130;   
        case '1d': return 1130;  
        default: return 300; 
    }
}

/**
 * Processa um array de velas históricas, calculando indicadores e features para a IA.
 * @param {Array<object>} candles - Array de velas brutas da Binance.
 * @param {string} timeframe - O tempo gráfico.
 * @returns {Array<object>} Array de objetos de dados prontos para a IA (com features e indicadores).
 */
function processHistoricalCandlesForAI(candles, timeframe) {
    const processedData = [];
    const closePrices = []; // Para calcular indicadores
    const volumes = []; // Para SMA de Volume

    const volumeSmaPeriod = STRATEGY_CONFIG.strategies.breakout?.volumeSmaPeriod || 20;

    candles.forEach((candle, index) => {
        closePrices.push(parseFloat(candle.close));
        volumes.push(parseFloat(candle.volume));

        // Calcular indicadores para este ponto histórico (recalculados passo a passo)
        const rsiVal = closePrices.length >= 14 ? RSI.calculate({ period: 14, values: closePrices }).pop() : null;
        const emaVal = closePrices.length >= 200 ? EMA.calculate({ period: 200, values: closePrices }).pop() : null;
        const bbVal = closePrices.length >= 20 ? BollingerBands.calculate({ period: 20, stdDev: 2, values: closePrices }).pop() : null;
        const smaVolumeVal = volumes.length >= volumeSmaPeriod ? SMA.calculate({ period: volumeSmaPeriod, values: volumes }).pop() : null;

        // Calcular features derivadas (como variação de preço/volume)
        const previousCandle = index > 0 ? candles[index - 1] : null;
        const currentClose = parseFloat(candle.close);
        const currentVolume = parseFloat(candle.volume);

        // Criar um objeto de dados completo para a IA
        const dataPointForAI = {
            timestamp: parseInt(candle.closeTime),
            open: parseFloat(candle.open),
            high: parseFloat(candle.high),
            low: parseFloat(candle.low),
            close: currentClose,
            volume: currentVolume,
            rsi: rsiVal,
            ema: emaVal,
            bb_upper: bbVal ? bbVal.upper : null,
            bb_lower: bbVal ? bbVal.lower : null,
            bb_middle: bbVal ? bbVal.middle : null,
            price_change_1m: previousCandle ? (currentClose - parseFloat(previousCandle.close)) / parseFloat(previousCandle.close) : 0,
            volume_change_1m: previousCandle ? (currentVolume - parseFloat(previousCandle.volume)) / parseFloat(previousCandle.volume) : 0,
        };
        processedData.push(dataPointForAI);
    });
    return processedData;
}

/**
 * Busca dados históricos via requisição HTTP para um símbolo e tempo gráfico.
 * Lida com erros (timeout, erro de solicitação) para não quebrar o bot.
 * @param {string} symbol - O par de trading (ex: 'BTCUSDT').
 * @param {string} timeframe - O tempo gráfico (ex: '1h').
 * @returns {Promise<Array<object> | null>} Promessa que resolve para um array de velas processadas com indicadores, ou null em caso de erro.
 */
async function getHistoricalData(symbol, timeframe) {
    if (!binanceClient) {
        log('error', `[DataHttp] ERRO: Cliente Binance não definido para o módulo DataHttp.`);
        return null;
    }
    try {
        const limitToFetch = getRequestedLimit(timeframe);
        log('info', `[DataHttp] Buscando ${limitToFetch} velas históricas via HTTP para ${symbol} - [${timeframe}]...`);

        // A requisição HTTP REST da Binance para velas históricas
        const candles = await binanceClient.futuresCandles({
            symbol: symbol,
            interval: timeframe,
            limit: limitToFetch
        });

        // Salva as velas brutas para uso do bot (merge incremental)
        const database = require('./database');
        const rawDataKey = `raw_candles_${symbol}_${timeframe}`;
        
        // Tenta carregar dados existentes do banco
        let existingRaw = [];
        const loadedRaw = await database.loadData(rawDataKey);
        if (loadedRaw) {
            existingRaw = loadedRaw;
            log('info', `[DataHttp] Velas brutas carregadas do MongoDB para ${symbol} - ${timeframe}.`);
        } else {
            // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
            if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
                const rawDir = path.join(__dirname, 'raw_candles');
                if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir);
                const rawFileName = `raw_candles_${symbol}_${timeframe}.json`;
                const rawFilePath = path.join(rawDir, rawFileName);
                if (fs.existsSync(rawFilePath)) {
                    existingRaw = JSON.parse(fs.readFileSync(rawFilePath, 'utf-8'));
                    log('info', `[DataHttp] Velas brutas carregadas do JSON (fallback) para ${symbol} - ${timeframe}.`);
                }
            } else {
                log('info', `[DataHttp] FORCE_MONGO_ONLY ativo - ignorando JSON para ${symbol} - ${timeframe}.`);
            }
        }
        
        // Só adiciona velas novas
        const newRaw = candles.filter(c => !existingRaw.some(e => e.openTime === c.openTime));
        const mergedRaw = existingRaw.concat(newRaw);
        
        // Tenta salvar no banco primeiro
        const rawSaved = await database.saveData(rawDataKey, mergedRaw);
        if (rawSaved) {
            log('info', `[DataHttp] Velas brutas salvas no MongoDB. (${newRaw.length} novas)`);
        } else {
            // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
            if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
                const rawDir = path.join(__dirname, 'raw_candles');
                if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir);
                const rawFileName = `raw_candles_${symbol}_${timeframe}.json`;
                const rawFilePath = path.join(rawDir, rawFileName);
                try {
                    fs.writeFileSync(rawFilePath, JSON.stringify(mergedRaw, null, 2));
                    log('info', `[DataHttp] Velas brutas salvas no JSON (fallback). (${newRaw.length} novas)`);
                } catch (err) {
                    log('error', `[DataHttp] ERRO ao salvar velas brutas:`, err);
                }
            } else {
                log('info', `[DataHttp] FORCE_MONGO_ONLY ativo - ignorando salvamento JSON para ${symbol} - ${timeframe}.`);
            }
        }

        // Processa para IA e salva também (merge incremental)
        const processedCandles = processHistoricalCandlesForAI(candles, timeframe);
        const aiDataKey = `historical_data_${symbol}_${timeframe}`;
        
        // Tenta carregar dados processados existentes do banco
        let existingAI = [];
        const loadedAI = await database.loadData(aiDataKey);
        if (loadedAI) {
            existingAI = loadedAI;
            log('info', `[DataHttp] Dados históricos para IA carregados do MongoDB para ${symbol} - ${timeframe}.`);
        } else {
            // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
            if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
                const aiDir = path.join(__dirname, 'historical_data');
                if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir);
                const aiFileName = `historical_data_${symbol}_${timeframe}.json`;
                const aiFilePath = path.join(aiDir, aiFileName);
                if (fs.existsSync(aiFilePath)) {
                    existingAI = JSON.parse(fs.readFileSync(aiFilePath, 'utf-8'));
                    log('info', `[DataHttp] Dados históricos para IA carregados do JSON (fallback) para ${symbol} - ${timeframe}.`);
                }
            } else {
                log('info', `[DataHttp] FORCE_MONGO_ONLY ativo - ignorando JSON para ${symbol} - ${timeframe}.`);
            }
        }
        
        // Só adiciona dados novos
        const newAI = processedCandles.filter(c => !existingAI.some(e => e.timestamp === c.timestamp));
        const mergedAI = existingAI.concat(newAI);
        
        // Tenta salvar no banco primeiro
        const aiSaved = await database.saveData(aiDataKey, mergedAI);
        if (aiSaved) {
            log('info', `[DataHttp] Dados históricos para IA salvos no MongoDB. (${newAI.length} novos)`);
        } else {
            // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
            if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
                const aiDir = path.join(__dirname, 'historical_data');
                if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir);
                const aiFileName = `historical_data_${symbol}_${timeframe}.json`;
                const aiFilePath = path.join(aiDir, aiFileName);
                try {
                    fs.writeFileSync(aiFilePath, JSON.stringify(mergedAI, null, 2));
                    log('info', `[DataHttp] Dados históricos para IA salvos no JSON (fallback). (${newAI.length} novos)`);
                } catch (err) {
                    log('error', `[DataHttp] ERRO ao salvar dados históricos:`, err);
                }
            } else {
                log('info', `[DataHttp] FORCE_MONGO_ONLY ativo - ignorando salvamento JSON para ${symbol} - ${timeframe}.`);
            }
        }

        return processedCandles;

    } catch (error) {
        // Captura e loga o erro sem relançá-lo, permitindo que o bot continue.
        log('error', `[DataHttp] ERRO ao buscar dados históricos para ${symbol} - [${timeframe}]:`, `[${error.code || 'S/C'}] ${error.message}`);
        log('info', `[DataHttp] Pulando dados históricos para ${symbol} - [${timeframe}] devido ao erro.`);
        return null; // Retorna null para indicar falha na coleta para este timeframe/símbolo.
    }
}

/**
 * Busca dados históricos em lote para múltiplos símbolos/timeframes em paralelo.
 * @param {Array<{symbol: string, timeframe: string}>} batchArray
 * @returns {Promise<Array<{symbol: string, timeframe: string, data: Array<object>}>>}
 */
async function getHistoricalDataBatch(batchArray) {
    const results = await Promise.all(
        batchArray.map(async ({ symbol, timeframe }) => {
            const data = await getHistoricalData(symbol, timeframe);
            return { symbol, timeframe, data };
        })
    );
    return results;
}

/**
 * Define o cliente Binance para este módulo. Deve ser chamado antes de usar getHistoricalData.
 * @param {object} clientInstance - O cliente Binance API.
 */
function setBinanceClient(clientInstance) {
    binanceClient = clientInstance;
}

module.exports = {
    setBinanceClient,
    getHistoricalData,
    getHistoricalDataBatch,
};