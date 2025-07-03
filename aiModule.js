// =================================================================================================
// 6. MÓDULO DE INTELIGÊNCIA ARTIFICIAL (Implementação Própria - Conceito de Perceptron Simplificado)
// =================================================================================================
const fs = require('fs');
const path = require('path');
const { RSI, EMA, BollingerBands, SMA } = require('technicalindicators');
const log = require('./log');

// Caminhos para os arquivos JSON (na raiz do projeto)
const AI_DATA_DIR = path.resolve(__dirname, 'ai_data');
if (!fs.existsSync(AI_DATA_DIR)) fs.mkdirSync(AI_DATA_DIR);
const AI_DB_FILE = path.join(AI_DATA_DIR, 'ai_data.json'); // path.resolve para garantir caminho absoluto
const AI_MODEL_FILE = path.join(AI_DATA_DIR, 'ai_model.json');
const AI_STATS_FILE = path.join(AI_DATA_DIR, 'ai_stats.json'); // Para estatísticas de normalização por par/timeframe

// NOVO: Pasta para dados em tempo real
const REALTIME_DATA_DIR = path.resolve(__dirname, 'realtime_data');
if (!fs.existsSync(REALTIME_DATA_DIR)) fs.mkdirSync(REALTIME_DATA_DIR);

// Cache em memória dos dados para treinamento da IA.
// Estrutura: { symbol: { timeframe: [dataPoint, ...] } }
let aiTrainingData = {};

// Nosso "modelo": um conjunto simples de pesos para cada feature e um bias
// ATENÇÃO: Este é um MODELO ÚNICO que tenta aprender para TODOS os pares.
// Para ter um modelo VERDADEIRAMENTE separado por par, aiModel teria que ser
// { symbol: { timeframe: { weights: {}, bias: {} } } } ou você usaria uma biblioteca de ML real.
let aiModel = {
    weights: {
        open: 0.0, high: 0.0, low: 0.0, close: 0.0, volume: 0.0,
        rsi: 0.0, ema: 0.0, bb_upper: 0.0, bb_lower: 0.0, bb_middle: 0.0,
        price_change_1m: 0.0, volume_change_1m: 0.0
    },
    bias: 0.0,
    learningRate: 0.001,
    epochs: 10,
    minDataForTraining: 200 // Mínimo de dados para iniciar o treinamento da IA
};

// NOVO: As estatísticas de normalização agora serão armazenadas por par e tempo gráfico
let dataStatsByPair = {}; // Estrutura: { symbol: { timeframe: { minOpen: ..., maxOpen: ... } } }
let isAIReadyForTrading = false; // Flag: Indica se a IA está treinada e pronta para dar sinais de trading

// Períodos dos indicadores para o cálculo de features na PREVISÃO (predict/predictExit)
// Estes são os mesmos que o botState usa ou são defaults.
const PREDICT_INDICATOR_PERIODS = {
    rsi: 14,
    ema: 200,
    bb: 20,
    smaVolume: 20 // Período padrão para SMA de Volume na previsão
};

/**
 * Normaliza um valor entre uma faixa mínima e máxima (Min-Max Scaling).
 */
function normalize(value, min, max) {
    if (min === Infinity || max === -Infinity || min === max) return 0;
    return (value - min) / (max - min);
}

/**
 * Extrai e pré-processa as features de um único ponto de dados.
 * @param {object} dataPoint - Objeto de dados (candle + indicators).
 * @param {object} stats - Estatísticas para normalização (ESPECÍFICAS DO PAR/TIMEFRAME).
 * @returns {Array<number>} - Vetor de features normalizado.
 */
function getFeatureVector(dataPoint, stats) {
    const features = [];
    const weightKeys = Object.keys(aiModel.weights);

    weightKeys.forEach(key => {
        let value = dataPoint[key];
        let min = stats[`min${key.charAt(0).toUpperCase() + key.slice(1)}`];
        let max = stats[`max${key.charAt(0).toUpperCase() + key.slice(1)}`];

        if (value === null || value === undefined || isNaN(value)) {
            value = 0;
        }
        features.push(normalize(value, min, max));
    });

    return features;
}

/**
 * Calcula estatísticas min/max para normalização para um conjunto de dados específico (par/timeframe).
 * @param {Array<object>} data - Dados para os quais calcular as estatísticas.
 * @returns {object} - Objeto com as estatísticas min/max para cada feature.
 */
function calculateDataStatsForSet(data) { // NOVO NOME para clareza
    const newStats = {};
    const featureKeys = Object.keys(aiModel.weights);

    featureKeys.forEach(key => {
        const values = data.map(dp => dp[key]).filter(v => v !== null && v !== undefined && !isNaN(v));
        if (values.length > 0) {
            newStats[`min${key.charAt(0).toUpperCase() + key.slice(1)}`] = Math.min(...values);
            newStats[`max${key.charAt(0).toUpperCase() + key.slice(1)}`] = Math.max(...values);
        } else {
            newStats[`min${key.charAt(0).toUpperCase() + key.slice(1)}`] = 0; // Fallback se não houver dados para a feature
            newStats[`max${key.charAt(0).toUpperCase() + key.slice(1)}`] = 1;
        }
    });
    return newStats;
}

/**
 * Adiciona um ponto de dado ao histórico de treinamento, verificando duplicatas e mantendo a ordem.
 * Esta é a ÚNICA função que modifica `aiTrainingData` para adicionar velas.
 * @param {string} symbol - O símbolo do par de trading.
 * @param {string} timeframe - O tempo gráfico da vela.
 * @param {object} dataPoint - O ponto de dado a ser adicionado (já com features raw e indicadores).
 */
function addDataPoint(symbol, timeframe, dataPoint) {
    if (!aiTrainingData[symbol]) aiTrainingData[symbol] = {};
    if (!aiTrainingData[symbol][timeframe]) aiTrainingData[symbol][timeframe] = [];

    const currentData = aiTrainingData[symbol][timeframe];

    // Verifica se a vela já existe (baseado no timestamp) para evitar duplicatas
    const exists = currentData.some(existingDp => existingDp.timestamp === dataPoint.timestamp);

    if (!exists) {
        currentData.push(dataPoint);
        // Mantém os dados ordenados por timestamp (fundamental para séries temporais)
        currentData.sort((a, b) => a.timestamp - b.timestamp);

        // Gerencia o tamanho máximo do histórico em memória para evitar consumo excessivo
        const maxDataPoints = 10000; // Manter até 10.000 velas por timeframe/símbolo
        if (currentData.length > maxDataPoints) {
            currentData.shift(); // Remove a vela mais antiga
        }
        return true; // Ponto de dado adicionado com sucesso
    }
    return false; // Ponto de dado já existia e não foi adicionado
}

/**
 * Inicializa o módulo de IA, carregando dados, modelo e estatísticas salvas.
 */
async function init() {
    try {
        // Tenta carregar do banco de dados primeiro
        const database = require('./database');
        
        // Carrega dados de treinamento
        const loadedData = await database.loadData('ai_data');
        if (loadedData) {
            aiTrainingData = loadedData;
            log('info', '🤖 Módulo de IA: Dados de treinamento carregados do MongoDB.');
            let totalLoaded = 0;
            for (const sym in aiTrainingData) {
                for (const tf in aiTrainingData[sym]) {
                    totalLoaded += aiTrainingData[sym][tf].length;
                }
            }
            log('info', `🤖 Módulo de IA: Total de ${totalLoaded} pontos de dados carregados do MongoDB.`);
        } else {
            // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
            const database = require('./database');
            if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
                if (!fs.existsSync(AI_DB_FILE)) {
                    fs.writeFileSync(AI_DB_FILE, JSON.stringify({}, null, 2));
                    log('info', '🤖 Módulo de IA: ai_data.json criado vazio.');
                }
                if (fs.existsSync(AI_DB_FILE)) {
                    aiTrainingData = JSON.parse(fs.readFileSync(AI_DB_FILE, 'utf-8'));
                    log('info', '🤖 Módulo de IA: Dados de treinamento carregados do JSON (fallback).');
                    let totalLoaded = 0;
                    for (const sym in aiTrainingData) {
                        for (const tf in aiTrainingData[sym]) {
                            totalLoaded += aiTrainingData[sym][tf].length;
                        }
                    }
                    log('info', `🤖 Módulo de IA: Total de ${totalLoaded} pontos de dados carregados de ai_data.json.`);
        } else {
            log('warning', '🤖 Módulo de IA: Banco de dados de IA não encontrado, iniciando com dados vazios.');
            aiTrainingData = {};
                }
            } else {
                log('warning', '🤖 Módulo de IA: FORCE_MONGO_ONLY ativo - ignorando JSON, iniciando com dados vazios.');
                aiTrainingData = {};
            }
        }

        // Carrega modelo
        const loadedModel = await database.loadData('ai_model');
        if (loadedModel) {
            aiModel = { ...aiModel, ...loadedModel };
            log('info', '🤖 Módulo de IA: Modelo de IA carregado do MongoDB.');
            isAIReadyForTrading = true;
        } else {
            // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
            if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
                if (!fs.existsSync(AI_MODEL_FILE)) {
                    fs.writeFileSync(AI_MODEL_FILE, JSON.stringify(aiModel, null, 2));
                    log('info', '🤖 Módulo de IA: ai_model.json criado com modelo padrão.');
                }
                if (fs.existsSync(AI_MODEL_FILE)) {
                    const loadedModelJson = JSON.parse(fs.readFileSync(AI_MODEL_FILE, 'utf-8'));
                    aiModel = { ...aiModel, ...loadedModelJson };
                    log('info', '🤖 Módulo de IA: Modelo de IA carregado do JSON (fallback).');
                    isAIReadyForTrading = true;
        } else {
            log('warning', '🤖 Módulo de IA: Modelo de IA não encontrado, iniciando com pesos padrão (NÃO PRONTA para trading).');
            isAIReadyForTrading = false;
        }
            } else {
                log('warning', '🤖 Módulo de IA: FORCE_MONGO_ONLY ativo - ignorando JSON, iniciando com modelo padrão (NÃO PRONTA para trading).');
                isAIReadyForTrading = false;
            }
        }

        // Carrega estatísticas
        const loadedStats = await database.loadData('ai_stats');
        if (loadedStats) {
            dataStatsByPair = loadedStats;
            log('info', '🤖 Módulo de IA: Estatísticas de normalização carregadas do MongoDB.');
        } else {
            // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
            if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
                if (!fs.existsSync(AI_STATS_FILE)) {
                    fs.writeFileSync(AI_STATS_FILE, JSON.stringify({}, null, 2));
                    log('info', '🤖 Módulo de IA: ai_stats.json criado vazio.');
                }
                if (fs.existsSync(AI_STATS_FILE)) {
                    dataStatsByPair = JSON.parse(fs.readFileSync(AI_STATS_FILE, 'utf-8'));
                    log('info', '🤖 Módulo de IA: Estatísticas de normalização carregadas do JSON (fallback).');
        } else {
            log('warning', '🤖 Módulo de IA: Estatísticas de normalização não encontradas.');
                    dataStatsByPair = {};
                }
            } else {
                log('warning', '🤖 Módulo de IA: FORCE_MONGO_ONLY ativo - ignorando JSON, iniciando com estatísticas vazias.');
                dataStatsByPair = {};
            }
        }

    } catch (error) {
        log('error', '🤖 Módulo de IA: Erro ao carregar dados/modelo/estatísticas:', error);
        aiTrainingData = {};
        aiModel.weights = Object.fromEntries(Object.keys(aiModel.weights).map(key => [key, 0.0]));
        aiModel.bias = 0.0;
        dataStatsByPair = {};
        isAIReadyForTrading = false;
    }
}

/**
 * Coleta dados de velas em tempo real e indicadores para treinamento da IA (via WebSocket).
 * Esta função é chamada pelo websocketService quando uma nova vela final é processada.
 * @param {string} symbol - O símbolo do par de trading.
 * @param {string} timeframe - O tempo gráfico da vela.
 * @param {object} candle - A vela final processada.
 * @param {object} indicators - Os indicadores calculados para esta vela.
 */
function collectData(symbol, timeframe, candle, indicators) {
    // Cria um ponto de dados completo para a IA
    const dataPoint = {
        timestamp: parseInt(candle.closeTime),
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: parseFloat(candle.close),
        volume: parseFloat(candle.volume),
        rsi: indicators.rsi,
        ema: indicators.ema,
        bb_upper: indicators.bb ? indicators.bb.upper : null,
        bb_lower: indicators.bb ? indicators.bb.lower : null,
        bb_middle: indicators.bb ? indicators.bb.middle : null,
        price_change_1m: 0, // Será calculado quando houver dados suficientes
        volume_change_1m: 0, // Será calculado quando houver dados suficientes
    };

    // Adiciona o ponto de dados ao histórico de treinamento
    const wasAdded = addDataPoint(symbol, timeframe, dataPoint);
    if (wasAdded) {
        log('info', `🤖 Módulo de IA: Existiam ${aiTrainingData[symbol][timeframe].length - 1} pontos, adicionados 1 novos, total agora ${aiTrainingData[symbol][timeframe].length} para ${symbol} - ${timeframe}.`);
    }
}

/**
 * Treina o modelo de IA usando os dados coletados.
 * Este processo é executado periodicamente para manter o modelo atualizado.
 */
async function train() {
    log('info', '🤖 Módulo de IA: Iniciando processo de treinamento...');

    // Verifica se há dados suficientes para treinar
    let totalDataPoints = 0;
    for (const symbol in aiTrainingData) {
        for (const timeframe in aiTrainingData[symbol]) {
            totalDataPoints += aiTrainingData[symbol][timeframe].length;
        }
    }

    if (totalDataPoints < aiModel.minDataForTraining) {
        log('warning', `🤖 Módulo de IA: Dados insuficientes para treinamento (${totalDataPoints}/${aiModel.minDataForTraining} pontos mínimos).`);
        return;
    }

    // Calcula estatísticas de normalização para cada par/timeframe
    log('info', '🤖 Módulo de IA: Calculando estatísticas de normalização...');
    for (const symbol in aiTrainingData) {
        if (!dataStatsByPair[symbol]) dataStatsByPair[symbol] = {};
        for (const timeframe in aiTrainingData[symbol]) {
            const data = aiTrainingData[symbol][timeframe];
            if (data.length > 0) {
                dataStatsByPair[symbol][timeframe] = calculateDataStatsForSet(data);
                log('info', `🤖 Módulo de IA: ${data.length} pontos novos desde o último treinamento para ${symbol} - ${timeframe}.`);
            }
        }
    }
    log('info', '🤖 Módulo de IA: Estatísticas de normalização atualizadas por par/timeframe.');

    // Treina o modelo usando todos os dados disponíveis
    log('info', '🤖 Módulo de IA: Treinando modelo...');
    let totalOverallLoss = 0;
    let totalTrainingSamples = 0;

        for (const symbol in aiTrainingData) {
            for (const timeframe in aiTrainingData[symbol]) {
                const data = aiTrainingData[symbol][timeframe];
                const currentDataStats = dataStatsByPair[symbol][timeframe];

                if (!currentDataStats) continue;

                const LOOK_AHEAD_CANDLES = 3;
                const PROFIT_THRESHOLD = 0.005;
                const LOSS_THRESHOLD = -0.005;

                const trainingSet = [];
                for (let i = 0; i < data.length - LOOK_AHEAD_CANDLES; i++) {
                    const currentDataPoint = data[i];
                    const futureCandle = data[i + LOOK_AHEAD_CANDLES];

                    if (!futureCandle || futureCandle.close === undefined || futureCandle.close === null) {
                        continue;
                    }

                    const futurePrice = futureCandle.close;
                    const priceChange = (futurePrice - currentDataPoint.close) / currentDataPoint.close;

                    let label;
                    if (priceChange >= PROFIT_THRESHOLD) {
                        label = 1;
                    } else if (priceChange <= LOSS_THRESHOLD) {
                        label = -1;
                    } else {
                        label = 0;
                    }
                    trainingSet.push({ features: currentDataPoint, label: label });
                }

                if (trainingSet.length === 0) continue;

                for (const item of trainingSet) {
                    const featureVector = getFeatureVector(item.features, currentDataStats);

                    let predictionScore = aiModel.bias;
                    const featureNamesInOrder = Object.keys(aiModel.weights);

                    for (let f = 0; f < featureVector.length; f++) {
                        const weightName = featureNamesInOrder[f];
                        if (aiModel.weights[weightName] !== undefined) {
                            predictionScore += featureVector[f] * aiModel.weights[weightName];
                        }
                    }

                    const error = item.label - predictionScore;

                    aiModel.bias += aiModel.learningRate * error;
                    for (let f = 0; f < featureVector.length; f++) {
                        const weightName = featureNamesInOrder[f];
                        if (aiModel.weights[weightName] !== undefined) {
                            aiModel.weights[weightName] += aiModel.learningRate * error * featureVector[f];
                        }
                    }
                    totalOverallLoss += Math.pow(error, 2);
                }
                totalTrainingSamples += trainingSet.length;
        }
    }
    log('info', `🤖 Módulo de IA: Modelo global treinado para todos os pares/timeframes.`);

    try {
        // Salva no banco de dados primeiro, com fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
        const database = require('./database');
        
        // Salva modelo
        const modelSaved = await database.saveData('ai_model', aiModel);
        if (!modelSaved && (!database.isConnected() || !database.FORCE_MONGO_ONLY)) {
        fs.writeFileSync(AI_MODEL_FILE, JSON.stringify(aiModel, null, 2));
            log('info', '🤖 Módulo de IA: Modelo salvo no JSON (fallback).');
        }
        
        // Salva dados de treinamento
        const dataSaved = await database.saveData('ai_data', aiTrainingData);
        if (!dataSaved && (!database.isConnected() || !database.FORCE_MONGO_ONLY)) {
            fs.writeFileSync(AI_DB_FILE, JSON.stringify(aiTrainingData, null, 2));
            log('info', '🤖 Módulo de IA: Dados salvos no JSON (fallback).');
        }
        
        // Salva estatísticas
        const statsSaved = await database.saveData('ai_stats', dataStatsByPair);
        if (!statsSaved && (!database.isConnected() || !database.FORCE_MONGO_ONLY)) {
            fs.writeFileSync(AI_STATS_FILE, JSON.stringify(dataStatsByPair, null, 2));
            log('info', '🤖 Módulo de IA: Estatísticas salvas no JSON (fallback).');
        }
        
        log('info', '🤖 Módulo de IA: Modelo, dados e estatísticas salvos.');
        isAIReadyForTrading = true; // IA está treinada e pronta!
    } catch (error) {
        log('error', '🤖 Módulo de IA: Erro ao salvar modelo/dados/estatísticas de treinamento:', error);
        isAIReadyForTrading = false; // Falha ao salvar, IA não está pronta
    }
}

/**
 * Faz uma previsão usando o modelo de IA treinado.
 * @param {string} symbol - O símbolo do par de trading.
 * @param {string} timeframe - O tempo gráfico da vela.
 * @param {Array<object>} latestCandles - As velas mais recentes para previsão.
 * @returns {{ action: 'LONG' | 'SHORT' | 'HOLD', confidence: number } | null} - Previsão da IA.
 */
async function predict(symbol, timeframe, latestCandles) {
    // A IA só pode prever se estiver treinada E tiver as estatísticas de normalização para o par/timeframe
    if (!isAIReadyForTrading || !dataStatsByPair[symbol] || !dataStatsByPair[symbol][timeframe]) {
        // CORRIGIDO: Referência a dataStatsByPair
        return null;
    }

    if (!latestCandles || latestCandles.length < 2) {
        return null;
    }

    const lastCandle = latestCandles[latestCandles.length - 1];
    const secondLastCandle = latestCandles[latestCandles.length - 2]; // CORRIGIDO: latestCandales -> latestCandles

    const closePricesForIndicators = latestCandles.map(c => parseFloat(c.close));
    const volumesForSma = latestCandles.map(c => parseFloat(c.volume));

    // Recalcula indicadores para o ponto de previsão.
    // É importante usar os mesmos períodos de indicadores usados no treinamento.
    const rsi = closePricesForIndicators.length >= PREDICT_INDICATOR_PERIODS.rsi ? RSI.calculate({ period: PREDICT_INDICATOR_PERIODS.rsi, values: closePricesForIndicators }).pop() : null;
    const ema = closePricesForIndicators.length >= PREDICT_INDICATOR_PERIODS.ema ? EMA.calculate({ period: PREDICT_INDICATOR_PERIODS.ema, values: closePricesForIndicators }).pop() : null;
    const bb = closePricesForIndicators.length >= PREDICT_INDICATOR_PERIODS.bb ? BollingerBands.calculate({ period: PREDICT_INDICATOR_PERIODS.bb, stdDev: 2, values: closePricesForIndicators }).pop() : null;
    const smaVolume = volumesForSma.length >= PREDICT_INDICATOR_PERIODS.smaVolume ? SMA.calculate({ period: PREDICT_INDICATOR_PERIODS.smaVolume, values: volumesForSma }).pop() : null;


    const currentFeaturesRaw = {
        open: parseFloat(lastCandle.open),
        high: parseFloat(lastCandle.high),
        low: parseFloat(lastCandle.low),
        close: parseFloat(lastCandle.close),
        volume: parseFloat(lastCandle.volume),
        rsi: rsi,
        ema: ema,
        bb_upper: bb ? bb.upper : null,
        bb_lower: bb ? bb.lower : null,
        bb_middle: bb ? bb.middle : null,
        price_change_1m: (parseFloat(lastCandle.close) - parseFloat(secondLastCandle.close)) / parseFloat(secondLastCandle.close),
        volume_change_1m: (parseFloat(lastCandle.volume) - parseFloat(secondLastCandle.volume)) / parseFloat(secondLastCandle.volume),
        // Adicione o smaVolume aqui se ele for uma feature do modelo (deve estar no `weights` de aiModel).
        // smaVolume: smaVolume // Se você adicionar 'smaVolume' aos pesos, descomente esta linha
    };

    // Obtém as estatísticas de normalização ESPECÍFICAS para o par/timeframe atual
    const currentDataStats = dataStatsByPair[symbol][timeframe];
    if (!currentDataStats) return null; // Garante que as stats existem antes de usar

    const featureVector = getFeatureVector(currentFeaturesRaw, currentDataStats); // Usa as stats específicas!

    let predictionScore = aiModel.bias;
    const featureNamesInOrder = Object.keys(aiModel.weights);

    for (let f = 0; f < featureVector.length; f++) {
        const weightName = featureNamesInOrder[f];
        if (aiModel.weights[weightName] !== undefined) {
            predictionScore += featureVector[f] * aiModel.weights[weightName];
        }
    }

    let action = 'HOLD';
    let confidence = 50;

    if (predictionScore > 0.5) {
        action = 'LONG';
        confidence = Math.min(95, 50 + (predictionScore - 0.5) * 100);
    } else if (predictionScore < -0.5) {
        action = 'SHORT';
        confidence = Math.min(95, 50 + (-predictionScore - 0.5) * 100);
    }

    if (confidence < 60 && Math.random() < 0.3) {
        action = 'HOLD';
        confidence = 50 + Math.random() * 5;
    }

    return { action, confidence: parseFloat(confidence.toFixed(2)) };
}

/**
 * Prevê se uma posição aberta deve ser fechada com base na análise da IA.
 */
async function predictExit(symbol, timeframe, latestCandles, currentPosition) {
    if (!isAIReadyForTrading) {
        return null;
    }
    if (!latestCandles || latestCandles.length < 2) return null;

    const lastCandle = latestCandles[latestCandles.length - 1];
    const currentPrice = parseFloat(lastCandle.close);

    let profitLossPercent = ((currentPrice - currentPosition.entryPrice) / currentPosition.entryPrice) * 100;
    if (currentPosition.side === 'SHORT') {
        profitLossPercent *= -1;
    }

    const closePricesForRSI = latestCandles.map(c => parseFloat(c.close));
    // Usa o período de RSI definido em PREDICT_INDICATOR_PERIODS
    const currentRSI = closePricesForRSI.length >= PREDICT_INDICATOR_PERIODS.rsi ? RSI.calculate({ period: PREDICT_INDICATOR_PERIODS.rsi, values: closePricesForRSI }).pop() : null;

    const AI_PROFIT_TAKE_TARGET = 1.0;
    const AI_CUT_LOSS_TARGET = -0.5;
    const EXTREME_RSI_OVERBOUGHT = 80;
    const EXTREME_RSI_OVERSOLD = 20;

    if (currentPosition.side === 'LONG') {
        if (profitLossPercent >= AI_PROFIT_TAKE_TARGET && currentRSI > EXTREME_RSI_OVERBOUGHT) {
            return { action: 'CLOSE', reason: 'AI_PROFIT_TAKE_OVERBOUGHT', confidence: parseFloat((85 + Math.random() * 10).toFixed(2)) };
        }
        if (profitLossPercent <= AI_CUT_LOSS_TARGET && currentRSI < EXTREME_RSI_OVERSOLD) {
            return { action: 'CLOSE', reason: 'AI_CUT_LOSS_OVERSOLD', confidence: parseFloat((70 + Math.random() * 15).toFixed(2)) };
        }
    } else if (currentPosition.side === 'SHORT') {
        if (profitLossPercent >= AI_PROFIT_TAKE_TARGET && currentRSI < EXTREME_RSI_OVERSOLD) {
            return { action: 'CLOSE', reason: 'AI_PROFIT_TAKE_OVERSOLD', confidence: parseFloat((85 + Math.random() * 10).toFixed(2)) };
        }
        if (profitLossPercent <= AI_CUT_LOSS_TARGET && currentRSI > EXTREME_RSI_OVERBOUGHT) {
            return { action: 'CLOSE', reason: 'AI_CUT_LOSS_OVERBOUGHT', confidence: parseFloat((70 + Math.random() * 15).toFixed(2)) };
        }
    }

    return null;
}

/**
 * Verifica se a IA está pronta para dar sinais de trading.
 */
function isReadyForTrading() {
    return isAIReadyForTrading;
}

/**
 * Retorna o número de pontos de dados coletados para um par/timeframe específico.
 */
function getCollectedDataCount(symbol, timeframe) {
    return aiTrainingData[symbol] && aiTrainingData[symbol][timeframe] ? aiTrainingData[symbol][timeframe].length : 0;
}

/**
 * Coleta dados históricos processados para a IA (via HTTP).
 * Esta função é chamada quando dados históricos são buscados via HTTP.
 * @param {string} symbol - O símbolo do par de trading.
 * @param {string} timeframe - O tempo gráfico.
 * @param {Array<object>} historicalProcessedData - Os dados históricos processados.
 */
function collectHistoricalDataFromHttp(symbol, timeframe, historicalProcessedData) {
    if (!historicalProcessedData || !Array.isArray(historicalProcessedData)) {
        log('warning', `🤖 Módulo de IA: Dados históricos inválidos para ${symbol} - ${timeframe}`);
        return;
    }

    let addedCount = 0;
    for (const dataPoint of historicalProcessedData) {
        if (addDataPoint(symbol, timeframe, dataPoint)) {
            addedCount++;
        }
    }

    if (addedCount > 0) {
        log('info', `🤖 Módulo de IA: Adicionados ${addedCount} pontos históricos para ${symbol} - ${timeframe}.`);
    }
}

module.exports = {
    init,
    collectData,
    train,
    predict,
    predictExit,
    isReadyForTrading,
    getCollectedDataCount,
    collectHistoricalDataFromHttp,
    aiModel // Exporta para que o bot.js possa acessar minDataForTraining
};