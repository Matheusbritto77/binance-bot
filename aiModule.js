// =================================================================================================
// 6. MÓDULO DE INTELIGÊNCIA ARTIFICIAL (Implementação Própria - Conceito de Perceptron Simplificado)
// =================================================================================================
const fs = require('fs');
const path = require('path');
const { RSI, EMA, BollingerBands, SMA } = require('technicalindicators');

// Caminhos para os arquivos JSON (na raiz do projeto)
const AI_DB_FILE = path.resolve(__dirname, 'ai_data.json'); // path.resolve para garantir caminho absoluto
const AI_MODEL_FILE = path.resolve(__dirname, 'ai_model.json');
const AI_STATS_FILE = path.resolve(__dirname, 'ai_stats.json'); // Para estatísticas de normalização por par/timeframe

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
        if (fs.existsSync(AI_DB_FILE)) {
            aiTrainingData = JSON.parse(fs.readFileSync(AI_DB_FILE, 'utf-8'));
            console.log('🤖 Módulo de IA: Dados de treinamento carregados do disco.');
            let totalLoaded = 0;
            for (const sym in aiTrainingData) {
                for (const tf in aiTrainingData[sym]) {
                    totalLoaded += aiTrainingData[sym][tf].length;
                }
            }
            console.log(`🤖 Módulo de IA: Total de ${totalLoaded} pontos de dados carregados de ai_data.json.`);
        } else {
            console.log('🤖 Módulo de IA: Banco de dados de IA não encontrado, iniciando com dados vazios.');
            aiTrainingData = {};
        }

        if (fs.existsSync(AI_MODEL_FILE)) {
            const loadedModel = JSON.parse(fs.readFileSync(AI_MODEL_FILE, 'utf-8'));
            aiModel = { ...aiModel, ...loadedModel };
            console.log('🤖 Módulo de IA: Modelo de IA carregado.');
            isAIReadyForTrading = true; // Se há um modelo salvo, a IA está pronta
        } else {
            console.log('🤖 Módulo de IA: Modelo de IA não encontrado, iniciando com pesos padrão (NÃO PRONTA para trading).');
            isAIReadyForTrading = false;
        }

        if (fs.existsSync(AI_STATS_FILE)) {
            dataStatsByPair = JSON.parse(fs.readFileSync(AI_STATS_FILE, 'utf-8')); // CORRIGIDO: Carrega para dataStatsByPair
            console.log('🤖 Módulo de IA: Estatísticas de normalização carregadas.');
        } else {
            console.log('🤖 Módulo de IA: Estatísticas de normalização não encontradas.');
            dataStatsByPair = {}; // Inicializa vazio se não encontrado
        }

    } catch (error) {
        console.error('🤖 Módulo de IA: Erro ao carregar dados/modelo/estatísticas do disco:', error);
        aiTrainingData = {}; // Reseta se houver erro
        aiModel.weights = Object.fromEntries(Object.keys(aiModel.weights).map(key => [key, 0.0]));
        aiModel.bias = 0.0;
        dataStatsByPair = {}; // CORRIGIDO: Reseta as stats também
        isAIReadyForTrading = false; // Erro ao carregar, então a IA não está pronta
    }
}

/**
 * Coleta dados de velas em tempo real e indicadores para treinamento da IA (via WebSocket).
 * @param {string} symbol - O símbolo do par de trading.
 * @param {string} timeframe - O tempo gráfico da vela.
 * @param {object} candle - O objeto de vela bruta da Binance.
 * @param {object} indicators - Indicadores técnicos calculados para a vela.
 */
function collectData(symbol, timeframe, candle, indicators) {
    const currentClose = parseFloat(candle.close);
    const currentVolume = parseFloat(candle.volume);

    // Para calcular price_change e volume_change, precisamos da vela anterior
    const currentDataArray = aiTrainingData[symbol]?.[timeframe] || [];
    const previousDataPoint = currentDataArray.length > 0 ? currentDataArray[currentDataArray.length - 1] : null;

    const dataPoint = {
        timestamp: parseInt(candle.closeTime),
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: currentClose,
        volume: currentVolume,
        rsi: indicators.rsi,
        ema: indicators.ema,
        bb_upper: indicators.bb ? indicators.bb.upper : null,
        bb_lower: indicators.bb ? indicators.bb.lower : null,
        bb_middle: indicators.bb ? indicators.bb.middle : null,
        price_change_1m: previousDataPoint ? (currentClose - previousDataPoint.close) / previousDataPoint.close : 0,
        volume_change_1m: previousDataPoint ? (currentVolume - previousDataPoint.volume) / previousDataPoint.volume : 0,
    };
    
    addDataPoint(symbol, timeframe, dataPoint); // Usa a função unificada de adição
}

/**
 * Coleta dados de velas históricas para o treinamento inicial da IA (via HTTP - DataHttp.js).
 * Estes dados já vêm pré-processados pelo DataHttp.js.
 * @param {string} symbol - O símbolo do par de trading.
 * @param {string} timeframe - O tempo gráfico da vela.
 * @param {Array<object>} historicalProcessedData - Array de objetos de dados já processados (com indicadores e features).
 */
function collectHistoricalDataFromHttp(symbol, timeframe, historicalProcessedData) {
    if (!historicalProcessedData || historicalProcessedData.length === 0) {
        console.log(`🤖 Módulo de IA: Nenhum dado histórico (HTTP) disponível para ${symbol} - ${timeframe}.`);
        return;
    }

    let addedCount = 0;
    historicalProcessedData.forEach(dp => {
        if (addDataPoint(symbol, timeframe, dp)) { // Usa a função unificada de adição
            addedCount++;
        }
    });
    console.log(`🤖 Módulo de IA: Adicionados ${addedCount} novos pontos de dados HISTÓRICOS (HTTP) para ${symbol} - ${timeframe}.`);
}

/**
 * Treina o modelo de IA usando uma abordagem simples de gradiente descendente em um modelo linear.
 * O treinamento é feito por par de moeda/timeframe para calcular stats específicas.
 */
async function train() {
    console.log('🤖 Módulo de IA: Iniciando processo de treinamento...');

    // Primeiro, vamos garantir que temos dados suficientes para TODOS os pares/timeframes
    // E calcular as estatísticas de normalização para CADA par/timeframe
    let allDataSufficient = true;
    const newStatsByPair = {}; // Armazenará as novas estatísticas por par/timeframe

    for (const symbol in aiTrainingData) {
        newStatsByPair[symbol] = {};
        for (const timeframe in aiTrainingData[symbol]) {
            const data = aiTrainingData[symbol][timeframe];
            if (data.length < aiModel.minDataForTraining) {
                console.log(`🤖 Módulo de IA: Poucos dados (${data.length}) para treinar ${symbol} - ${timeframe}. Mínimo: ${aiModel.minDataForTraining}`);
                allDataSufficient = false;
                continue; // Não calcula stats se não há dados suficientes
            }
            // Calcula as estatísticas de normalização para ESTE CONJUNTO ESPECÍFICO
            newStatsByPair[symbol][timeframe] = calculateDataStatsForSet(data);
        }
    }

    if (!allDataSufficient) {
        console.log('🤖 Módulo de IA: Treinamento abortado. Dados insuficientes para um ou mais pares/timeframes.');
        isAIReadyForTrading = false; // IA não está pronta se não pôde treinar todos os pares
        try { // Salva os dados coletados mesmo se o treinamento for abortado
            fs.writeFileSync(AI_DB_FILE, JSON.stringify(aiTrainingData, null, 2));
            console.log('🤖 Módulo de IA: Dados de treinamento coletados salvos.');
        } catch (error) {
            console.error('🤖 Módulo de IA: Erro ao salvar dados de treinamento coletados:', error);
        }
        return;
    }

    // Se todos os dados são suficientes, atualiza as estatísticas globais
    dataStatsByPair = newStatsByPair; // CORRIGIDO: Atribui a variável global `dataStatsByPair`
    console.log('🤖 Módulo de IA: Estatísticas de normalização atualizadas por par/timeframe.');

    // Agora, realiza o treinamento (ajuste de pesos) para o modelo global
    let totalOverallLoss = 0;
    let totalTrainingSamples = 0;

    for (let epoch = 0; epoch < aiModel.epochs; epoch++) {
        totalOverallLoss = 0;
        totalTrainingSamples = 0;

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
    }
    console.log(`🤖 Módulo de IA: Modelo global treinado para todos os pares/timeframes.`);

    try {
        fs.writeFileSync(AI_MODEL_FILE, JSON.stringify(aiModel, null, 2));
        fs.writeFileSync(AI_DB_FILE, JSON.stringify(aiTrainingData, null, 2)); // Salva os dados ATUALIZADOS
        fs.writeFileSync(AI_STATS_FILE, JSON.stringify(dataStatsByPair, null, 2)); // CORRIGIDO: Salva dataStatsByPair
        console.log('🤖 Módulo de IA: Modelo, dados e estatísticas salvos no disco.');
        isAIReadyForTrading = true; // IA está treinada e pronta!
    } catch (error) {
        console.error('🤖 Módulo de IA: Erro ao salvar modelo/dados/estatísticas de treinamento:', error);
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

    if (Math.random() < 0.001) {
        return { action: 'CLOSE', reason: 'AI_UNEXPECTED_PATTERN', confidence: 60 };
    }

    return null;
}

/**
 * Retorna o status de prontidão da IA (se está treinada e pronta para dar sinais de trading).
 * @returns {boolean} True se a IA estiver pronta para trading, false caso contrário.
 */
function isReadyForTrading() {
    return isAIReadyForTrading;
}

/**
 * Retorna a contagem de dados coletados para um símbolo e timeframe específicos.
 * @param {string} symbol - O símbolo.
 * @param {string} timeframe - O tempo gráfico.
 * @returns {number} O número de pontos de dados coletados para aquele par/timeframe.
 */
function getCollectedDataCount(symbol, timeframe) {
    return aiTrainingData[symbol]?.[timeframe]?.length || 0;
}

module.exports = {
    init,
    collectData, // Para dados em tempo real (WebSocket)
    collectHistoricalDataFromHttp, // Para dados históricos (HTTP)
    train,
    predict,
    predictExit,
    isReadyForTrading,
    getCollectedDataCount
};