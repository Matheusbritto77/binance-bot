// =================================================================================================
// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL (bot.js)
// =================================================================================================
const Binance = require('binance-api-node').default;
const { RSI, EMA, MACD, SMA, BollingerBands } = require('technicalindicators');
const fs = require('fs');
const path = require('path');

const aiModule = require('./aiModule');
const websocketService = require('./websocketService');
const dataHttp = require('./dataHttp');

const apiKey = '';
const apiSecret = ''; // POR FAVOR, SUBSTITUA PELA SUA CHAVE SECRETA REAL!

const STRATEGY_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[37m" };
const client = Binance({ apiKey, apiSecret, timeSync: true, recvWindow: 15000 }); // recvWindow aumentado para 15 segundos

let botState = {};
let exchangeRules = {}; // Armazena precisões de quantidade e preço

// =================================================================================================
// 2. CÉREBRO PRINCIPAL DO BOT (ANÁLISE MULTI-TIMEFRAME E AI)
// =================================================================================================

/**
 * Função de callback chamada pelo websocketService quando uma nova vela final é processada.
 * @param {string} symbol - O par de trading.
 * @param {string} timeframe - O tempo gráfico da vela.
 * @param {object} candle - O objeto de vela da Binance.
 * @param {object} indicators - Indicadores técnicos calculados para a vela.
 */
async function onNewCandleProcessed(symbol, timeframe, candle, indicators) {
    // A IA deve coletar os dados processados em tempo real (do WebSocket)
    aiModule.collectData(symbol, timeframe, candle, indicators);

    // Só executa a estratégia principal para o timeframe principal (o primeiro da lista)
    // Isso evita decisões duplicadas e garante que a lógica principal seja baseada no tempo gráfico mais rápido
    if (timeframe === STRATEGY_CONFIG.timeframesToWatch[0]) {
        // Loga a vela principal processada, mas apenas se o histórico estiver pronto para operar
        const symbolState = websocketService.getBotState()[symbol];
        if (symbolState?.data[timeframe]?.isReady) {
            console.log(colors.cyan, `\n[${new Date().toLocaleTimeString()}] [${symbol}] [${timeframe}] Vela Principal Processada!`, colors.reset);
            await runMasterStrategy(symbol, timeframe);
        } else {
            console.log(colors.gray, `\n[${new Date().toLocaleTimeString()}] [${symbol}] [${timeframe}] Vela final recebida, mas histórico ainda não PRONTO para operação.`, colors.reset);
        }
    }
}

/**
 * Lógica principal de decisão para cada par e tempo gráfico.
 * Gerencia posições abertas ou busca novas oportunidades.
 * @param {string} symbol - O par de trading.
 * @param {string} timeframe - O tempo gráfico atual.
 */
async function runMasterStrategy(symbol, timeframe) {
    const symbolState = websocketService.getBotState()[symbol];

    // Checagem de histórico suficiente para operar (já filtrado em onNewCandleProcessed, mas redundante para segurança)
    if (!symbolState?.data[timeframe]?.candles || symbolState.data[timeframe].candles.length < websocketService.MIN_CANDLES_FOR_FULL_INDICATORS || !symbolState.data[timeframe].isReady) {
        console.log(colors.gray, `  [${symbol}] [${timeframe}] Histórico insuficiente para tomar decisões ou gerenciar. Pulando.`, colors.reset);
        return;
    }

    // --- PRIORIDADE MÁXIMA: GERENCIAR POSIÇÕES ABERTAS ---
    // O bot SEMPRE tentará gerenciar posições ativas, independentemente do saldo atual.
    if (symbolState.position.side !== 'NONE') {
        console.log(colors.cyan, `  [${symbol}] Gerenciando posição ${symbolState.position.side} ativa.`, colors.reset);
        await manageOpenPosition(symbol);
        return; // Termina o ciclo para este símbolo após gerenciar a posição
    }

    // --- Lógica para ABRIR NOVAS POSIÇÕES (requer saldo suficiente) ---
    // Verifica o saldo disponível em tempo real ANTES de procurar por sinais de entrada.
    // Isso evita que o bot gere logs de "nenhuma oportunidade" quando o problema é apenas falta de saldo.
    let usdtBalance = 0;
    try {
        const accountInfo = await client.futuresAccountInfo();
        usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === STRATEGY_CONFIG.quoteAsset)?.availableBalance || '0');
    } catch (error) {
        console.error(colors.red, `  [${symbol}] ERRO ao verificar saldo para novas posições:`, error.message, colors.reset);
        console.log(colors.yellow, `  [${symbol}] Não foi possível verificar saldo. Ignorando novas entradas.`, colors.reset);
        return; // Pula novas entradas se não puder verificar o saldo
    }
    
    // Usa um mínimo configurável para entradas (ex: 10 USDT de valor nocional mínimo)
    if (usdtBalance < STRATEGY_CONFIG.minNotionalForNewOrder) { 
        console.log(colors.yellow, `  [${symbol}] Saldo disponível (${usdtBalance.toFixed(2)} ${STRATEGY_CONFIG.quoteAsset}) abaixo do mínimo (${STRATEGY_CONFIG.minNotionalForNewOrder} USDT) para abrir novas posições. Somente observando.`, colors.reset);
        return; // Não procura sinais de entrada se o saldo for muito baixo para uma nova ordem
    }

    const { strategies, aiModule: aiModuleConfig } = STRATEGY_CONFIG;
    let signal = null; // O sinal final de entrada
    let aiReasoning = null; // A "opinião" da IA para confluência/conflito

    // 1. Tenta obter uma previsão da IA se ela estiver habilitada e pronta
    if (aiModuleConfig.enabled && aiModule.isReadyForTrading()) {
        const aiPrediction = await aiModule.predict(symbol, timeframe, symbolState.data[timeframe].candles);

        if (aiPrediction && aiPrediction.action !== 'HOLD') {
            if (aiPrediction.confidence > 70) { // IA com ALTA confiança, considera como sinal primário
                console.log(colors.magenta, `\n[${symbol}] 🤖 PREVISÃO DA IA (confiança ALTA): ${aiPrediction.action} (${aiPrediction.confidence.toFixed(2)}%)`);
                signal = {
                    side: aiPrediction.action,
                    strategy: 'AI_Prediction',
                    config: {
                        takeProfitPercent: aiModuleConfig.tradeConfig.takeProfitPercent,
                        stopLossPercent: aiModuleConfig.tradeConfig.stopLossPercent,
                        useInvalidationExit: true // IA gerencia sua própria saída
                    }
                };
                aiReasoning = aiPrediction.action;
            } else if (aiPrediction.confidence > 50) { // IA com MÉDIA confiança, usa como confluência
                console.log(colors.gray, `  [${symbol}] 🤖 PREVISÃO DA IA (confiança média): ${aiPrediction.action} (${aiPrediction.confidence.toFixed(2)}%). Usando como confluência.`, colors.reset);
                aiReasoning = aiPrediction.action;
            }
        } else if (aiPrediction && aiPrediction.action === 'HOLD') {
            console.log(colors.gray, `  [${symbol}] 🤖 PREVISÃO DA IA: HOLD (${aiPrediction.confidence.toFixed(2)}%).`, colors.reset);
            aiReasoning = 'HOLD';
        }
    } else if (aiModuleConfig.enabled && !aiModule.isReadyForTrading()) {
        console.log(colors.gray, `  [${symbol}] 🤖 IA ainda em treinamento ou não pronta. Usando apenas estratégias tradicionais.`, colors.reset);
    }

    // 2. Busca sinais das estratégias tradicionais (fallback ou confluência)
    if (!signal) { // Se a IA não deu um sinal forte o suficiente para entrada direta
        let traditionalSignal = null;
        if (strategies.trendFollowing.enabled) {
            traditionalSignal = checkTrendFollowingStrategy(symbol, strategies.trendFollowing);
        }
        if (!traditionalSignal && strategies.meanReversion.enabled) {
            traditionalSignal = checkMeanReversionStrategy(symbol, strategies.meanReversion);
        }
        if (!traditionalSignal && strategies.breakout.enabled) {
            traditionalSignal = checkBreakoutStrategy(symbol, strategies.breakout);
        }

        if (traditionalSignal) {
            // Se a IA está pronta E a previsão da IA CONFLITA com o sinal tradicional, IGNORA
            if (aiModule.isReadyForTrading() && aiReasoning && aiReasoning !== 'HOLD' && aiReasoning !== traditionalSignal.side) {
                console.log(colors.yellow, `\n[${symbol}] 🔀 SINAL TRADICIONAL CONFLITANTE COM IA (${traditionalSignal.side} vs IA ${aiReasoning}). IGNORANDO.`, colors.reset);
                signal = null; // Zera o sinal se houver conflito
            }
            // Se a IA está pronta E a previsão da IA CONFLUI com o sinal tradicional, USA
            else if (aiModule.isReadyForTrading() && aiReasoning === traditionalSignal.side) {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL TRADICIONAL (${traditionalSignal.strategy}) + IA CONFLUÊNCIA: ${traditionalSignal.side}`);
                signal = traditionalSignal;
            }
            // Se a IA NÃO ESTÁ PRONTA OU diz HOLD, USA o sinal tradicional sem confluência/conflito
            else {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL TRADICIONAL (${traditionalSignal.strategy}) (IA não relevante ou HOLD): ${traditionalSignal.side}`);
                signal = traditionalSignal;
            }
        }
    }

    // 3. Se um sinal final foi decidido, tenta abrir a posição
    if (signal) {
        console.log(colors.green, `\n[${symbol}] 📈 SINAL DE ENTRADA FINAL: ${signal.strategy} (${signal.side})`);
        await openPosition(symbol, signal); // Chama a função para abrir a ordem
    } else {
        console.log(`  [${symbol}] Nenhuma oportunidade com confluência encontrada.`);
    }
}

/**
 * Gerencia uma posição aberta, verificando SL/TP e invalidações.
 * @param {string} symbol - O par de trading.
 */
async function manageOpenPosition(symbol) {
    const symbolState = websocketService.getBotState()[symbol];
    // Desestrutura os dados da posição, incluindo os IDs e preços de SL/TP
    const { entryPrice, side, activeStrategyConfig, activeStrategy, quantity, currentStopLossPrice, currentTakeProfitPrice, stopLossOrderId, takeProfitOrderId } = symbolState.position;
    const { takeProfitPercent, stopLossPercent, useInvalidationExit } = activeStrategyConfig;
    const { takerFeePercent } = STRATEGY_CONFIG;
    const price = symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice; // Preço atual de mercado
    let closeReason = null; // Razão para fechar a posição

    // Calculo do PnL atual para logs e decisões
    const pnl = side === 'LONG'
        ? (price - entryPrice) * quantity
        : (entryPrice - price) * quantity;
    const pnlPercent = (pnl / (entryPrice * quantity)) * 100;

    console.log(colors.cyan, `  [${symbol}] Posição ${side} aberta (${activeStrategy}). PnL: ${pnl.toFixed(2)} USDT (${pnlPercent.toFixed(2)}%)`, colors.reset);


    // 1. **Sincronizar/Colocar Ordens SL/TP Iniciais na Binance**
    // Verifica se os IDs das ordens de SL/TP estão nulos no estado do bot.
    // Isso pode acontecer ao iniciar o bot com uma posição já aberta na Binance.
    if (stopLossOrderId === null || takeProfitOrderId === null) {
        console.log(colors.yellow, `  [${symbol}] Ordens SL/TP não rastreadas. Tentando configurar ordens automáticas para a posição aberta.`, colors.reset);
        await placeInitialStopLossAndTakeProfit(symbol, quantity, side, entryPrice, takeProfitPercent, stopLossPercent);
        return; // Retorna para o próximo ciclo para evitar processamento duplicado enquanto as ordens estão sendo colocadas
    }

    // 2. **Lógica de Trailing Stop Loss ou Move Stop to Break Even (SL Dinâmico)**
    // O objetivo é mover o Stop Loss para proteger lucros à medida que o preço se move a favor.
    const currentPnLPercent = pnlPercent;

    // Preço de Break-Even (ponto de equilíbrio + taxas de entrada/saída)
    const breakEvenPrice = side === 'LONG'
        ? entryPrice * (1 + (takerFeePercent * 2) / 100)
        : entryPrice * (1 - (takerFeePercent * 2) / 100);

    // Parâmetros para Trailing Stop (configuráveis)
    const TRAIL_ACTIVATION_PERCENT = STRATEGY_CONFIG.trailingStop?.activationPercent || 0.5; // Ex: ativa trailing quando PnL >= 0.5%
    const TRAIL_PROFIT_PROTECTION_PERCENT = STRATEGY_CONFIG.trailingStop?.profitProtectionPercent || 0.2; // Ex: move SL para garantir 0.2% de lucro

    let potentialNewStopLossPrice = currentStopLossPrice; // Começa com o SL atual

    if (side === 'LONG') {
        if (currentPnLPercent >= TRAIL_ACTIVATION_PERCENT) {
            // Calcula o novo SL para garantir lucro ou mover para break-even
            const calculatedTrailingSL = price * (1 - TRAIL_PROFIT_PROTECTION_PERCENT / 100);
            // O novo SL deve ser MAIOR que o SL atual E maior que o break-even
            if (calculatedTrailingSL > currentStopLossPrice) { // Só move se o novo SL for melhor que o atual
                potentialNewStopLossPrice = Math.max(calculatedTrailingSL, breakEvenPrice);
            }
        }
    } else { // SHORT
        if (currentPnLPercent >= TRAIL_ACTIVATION_PERCENT) {
            // Calcula o novo SL para garantir lucro ou mover para break-even
            const calculatedTrailingSL = price * (1 + TRAIL_PROFIT_PROTECTION_PERCENT / 100);
            // O novo SL deve ser MENOR que o SL atual E menor que o break-even
            if (calculatedTrailingSL < currentStopLossPrice) { // Só move se o novo SL for melhor que o atual
                potentialNewStopLossPrice = Math.min(calculatedTrailingSL, breakEvenPrice);
            }
        }
    }

    // Compara o novo SL calculado com o SL ativo no estado do bot para evitar chamadas de API desnecessárias
    const SL_PRECISION = exchangeRules[symbol].pricePrecision !== undefined ? exchangeRules[symbol].pricePrecision : 8;
    const formattedPotentialNewSL = parseFloat(potentialNewStopLossPrice).toFixed(SL_PRECISION);

    // Condição para atualizar o SL:
    // 1. O novo preço de SL é diferente do atual SL armazenado.
    // 2. O novo SL é de fato "melhor" (garante mais lucro ou menor perda).
    // 3. Há uma diferença significativa para evitar arredondamentos minúsculos.
    if (Math.abs(parseFloat(formattedPotentialNewSL) - currentStopLossPrice) > (0.00000001) // Margem de erro mínima para floats
        && ((side === 'LONG' && parseFloat(formattedPotentialNewSL) > currentStopLossPrice) || (side === 'SHORT' && parseFloat(formattedPotentialNewSL) < currentStopLossPrice)) ) {
        
        console.log(colors.magenta, `  [${symbol}] 🚀 MOVENDO STOP LOSS de ${currentStopLossPrice.toFixed(SL_PRECISION)} para ${formattedPotentialNewSL}.`, colors.reset);
        const success = await updateStopLoss(symbol, quantity, side, formattedPotentialNewSL, symbolState.position.stopLossOrderId);
        if (success) {
            symbolState.position.currentStopLossPrice = parseFloat(formattedPotentialNewSL); // Atualiza no estado do bot
        }
        return; // Retorna para evitar múltiplas ações no mesmo ciclo
    }


    // 3. Checagem de Stop-Loss e Take-Profit fixos (fallback: se a ordem na Binance falhou ou não foi capturada)
    // Esta é uma checagem de "segurança". As ordens `STOP_MARKET` e `TAKE_PROFIT_MARKET` na Binance
    // deveriam fechar a posição automaticamente. Mas esta lógica serve como um fallback no bot.
    const calculatedSlPriceForFallback = entryPrice * (side === 'LONG' ? (1 - stopLossPercent / 100) : (1 + stopLossPercent / 100));
    const calculatedTpPriceForFallback = entryPrice * (side === 'LONG' ? (1 + adjustedTakeProfitPercent / 100) : (1 - adjustedTakeProfitPercent / 100));

    if ((side === 'LONG' && price <= calculatedSlPriceForFallback) || (side === 'SHORT' && price >= calculatedSlPriceForFallback)) {
        closeReason = 'STOP-LOSS_FALLBACK';
    } else if ((side === 'LONG' && price >= calculatedTpPriceForFallback) || (side === 'SHORT' && price <= calculatedTpPriceForFallback)) {
        closeReason = 'TAKE-PROFIT_FALLBACK';
    }


    // 4. Invalidação impulsionada pela IA (se a IA abriu a posição)
    if (!closeReason && activeStrategy === 'AI_Prediction' && useInvalidationExit && STRATEGY_CONFIG.aiModule.enabled && aiModule.isReadyForTrading()) {
        const aiCloseSignal = await aiModule.predictExit(symbol, STRATEGY_CONFIG.timeframesToWatch[0], symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].candles, symbolState.position);
        if (aiCloseSignal && aiCloseSignal.action === 'CLOSE') {
            console.log(colors.magenta, `  [${symbol}] 🤖 SINAL DE SAÍDA DA IA: ${aiCloseSignal.reason} (${aiCloseSignal.confidence.toFixed(2)}% de confiança)`);
            closeReason = 'AI_EXIT_SIGNAL';
        }
    }

    // 5. Invalidação de Estratégia Tradicional
    if (!closeReason && useInvalidationExit && activeStrategy !== 'AI_Prediction') {
        let isSignalStillValid = true;
        if (activeStrategy === 'TrendFollowing') {
            const longTermTimeframe = STRATEGY_CONFIG.timeframesToWatch[STRATEGY_CONFIG.timeframesToWatch.length - 1];
            const longTermEma = symbolState.data[longTermTimeframe].indicators.ema;
            if ((side === 'LONG' && price < longTermEma) || (side === 'SHORT' && price > longTermEma)) {
                isSignalStillValid = false;
            }
        } else if (activeStrategy === 'MeanReversion') {
            const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
            const { bb } = symbolState.data[triggerTF].indicators;
            if (bb && ((side === 'LONG' && price > bb.middle) || (side === 'SHORT' && price < bb.middle))) {
                isSignalStillValid = false;
            }
        } else if (activeStrategy === 'Breakout') {
            const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
            const { bb } = symbolState.data[triggerTF].indicators;
            if (bb && ((side === 'LONG' && price < bb.middle) || (side === 'SHORT' && price > bb.middle))) {
                isSignalStillValid = false;
            }
        }

        if (!isSignalStillValid) {
            closeReason = 'INVALIDATION';
        }
    }

    // Se uma razão de fechamento foi encontrada, execute o fechamento.
    if (closeReason) {
        console.log(colors.yellow, `\n[${symbol}] 🚨 SINAL PARA FECHAR POSIÇÃO ${side}! Motivo: ${closeReason}`);
        await closePosition(symbol, closeReason);
    }
}

// =================================================================================================
// 3. MÓDULO DE ESTRATÉGIAS (TRADICIONAIS) - (Sem Alterações)
// =================================================================================================

function checkTrendFollowingStrategy(symbol, config) {
    const symbolState = websocketService.getBotState()[symbol];
    const timeframes = STRATEGY_CONFIG.timeframesToWatch;
    const triggerTF = timeframes[0];
    const confirmationTF = timeframes[timeframes.length - 1];

    const triggerIndicators = symbolState.data[triggerTF].indicators;
    const confirmationIndicators = symbolState.data[confirmationTF].indicators;
    const price = symbolState.data[triggerTF].lastPrice;

    if (!triggerIndicators || !confirmationIndicators || triggerIndicators.rsi === null || confirmationIndicators.ema === null) return null;

    const longConfluence =
        price > confirmationIndicators.ema &&
        triggerIndicators.rsi < config.rsiOversold;

    if (longConfluence) {
        return { side: 'LONG', strategy: 'TrendFollowing', config };
    }

    const shortConfluence =
        price < confirmationIndicators.ema &&
        triggerIndicators.rsi > config.rsiOverbought;

    if (shortConfluence) {
        return { side: 'SHORT', strategy: 'TrendFollowing', config };
    }

    return null;
}

function checkMeanReversionStrategy(symbol, config) {
    const symbolState = websocketService.getBotState()[symbol];
    const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
    const { bb, rsi } = symbolState.data[triggerTF].indicators;
    const price = symbolState.data[triggerTF].lastPrice;

    if (!bb || !rsi || bb.lower === null || bb.upper === null || rsi === null) return null;

    if (price < bb.lower && rsi < config.rsiOversold) {
        return { side: 'LONG', strategy: 'MeanReversion', config };
    }
    if (price > bb.upper && rsi > config.rsiOverbought) {
        return { side: 'SHORT', strategy: 'MeanReversion', config };
    }
    return null;
}

function checkBreakoutStrategy(symbol, config) {
    const symbolState = websocketService.getBotState()[symbol];
    const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
    const { bb, smaVolume } = symbolState.data[triggerTF].indicators;
    const price = symbolState.data[triggerTF].lastPrice;
    const currentVolume = symbolState.data[triggerTF].candles[symbolState.data[triggerTF].candles.length - 1].volume;

    if (!bb || bb.upper === null || bb.lower === null || smaVolume === null || !currentVolume) return null;

    if (price > bb.upper && currentVolume > (smaVolume * config.minVolumeSpike)) {
        return { side: 'LONG', strategy: 'Breakout', config };
    }
    if (price < bb.lower && currentVolume > (smaVolume * config.minVolumeSpike)) {
        return { side: 'SHORT', strategy: 'Breakout', config };
    }
    return null;
}

// =================================================================================================
// 4. FUNÇÕES DE ORDEM E AUXILIARES (MODIFICADAS)
// =================================================================================================

/**
 * Função para colocar as ordens iniciais de SL e TP (Limitadas) na Binance.
 * Essas ordens são do tipo STOP_MARKET e TAKE_PROFIT_MARKET.
 * @param {string} symbol - O par de trading.
 * @param {number} quantity - A quantidade da posição.
 * @param {string} side - 'LONG' ou 'SHORT'.
 * @param {number} entryPrice - Preço de entrada da posição.
 * @param {number} takeProfitPercent - Porcentagem de Take Profit da estratégia.
 * @param {number} stopLossPercent - Porcentagem de Stop Loss da estratégia.
 */
async function placeInitialStopLossAndTakeProfit(symbol, quantity, side, entryPrice, takeProfitPercent, stopLossPercent) {
    const { takerFeePercent } = STRATEGY_CONFIG;
    // Puxa a precisão de preço das regras da exchange
    const PRICE_PRECISION = exchangeRules[symbol].pricePrecision !== undefined ? exchangeRules[symbol].pricePrecision : 8;
    const QUANTITY_PRECISION = exchangeRules[symbol].quantityPrecision !== undefined ? exchangeRules[symbol].quantityPrecision : 8;

    const adjustedTakeProfitPercent = takeProfitPercent + (takerFeePercent * 2); // Ajusta TP para cobrir taxas

    // Calcula os preços de Stop Loss e Take Profit
    const slPriceRaw = side === 'LONG'
        ? entryPrice * (1 - stopLossPercent / 100)
        : entryPrice * (1 + stopLossPercent / 100);
    const tpPriceRaw = side === 'LONG'
        ? entryPrice * (1 + adjustedTakeProfitPercent / 100)
        : entryPrice * (1 - adjustedTakeProfitPercent / 100);

    // Formata os preços para a precisão correta do par
    const formattedSlPrice = parseFloat(slPriceRaw).toFixed(PRICE_PRECISION);
    const formattedTpPrice = parseFloat(tpPriceRaw).toFixed(PRICE_PRECISION);

    const orderSideForExit = side === 'LONG' ? 'SELL' : 'BUY'; // Lado da ordem de saída

    try {
        // Envia a ordem de STOP_MARKET (Stop Loss)
        const stopLossOrder = await client.futuresOrder({
            symbol,
            side: orderSideForExit,
            type: 'STOP_MARKET',
            quantity: quantity.toFixed(QUANTITY_PRECISION),
            stopPrice: formattedSlPrice, // Preço que aciona a ordem a mercado
            closePosition: 'true', // Garante que a ordem fecha a posição
            newClientOrderId: `SL_${symbol}_${Date.now()}` // ID único para rastreamento
        });
        console.log(colors.red, `  [${symbol}] 🛑 Ordem STOP_LOSS enviada: ${orderSideForExit} ${quantity.toFixed(QUANTITY_PRECISION)} @ StopPrice ${formattedSlPrice}`);

        // Envia a ordem de TAKE_PROFIT_MARKET (Take Profit)
        const takeProfitOrder = await client.futuresOrder({
            symbol,
            side: orderSideForExit,
            type: 'TAKE_PROFIT_MARKET',
            quantity: quantity.toFixed(QUANTITY_PRECISION),
            stopPrice: formattedTpPrice, // Preço que aciona a ordem a mercado
            closePosition: 'true', // Garante que a ordem fecha a posição
            newClientOrderId: `TP_${symbol}_${Date.now()}`
        });
        console.log(colors.green, `  [${symbol}] ✅ Ordem TAKE_PROFIT enviada: ${orderSideForExit} ${quantity.toFixed(QUANTITY_PRECISION)} @ StopPrice ${formattedTpPrice}`);

        // Atualiza o estado da posição no botState com os IDs das ordens e os preços definidos
        const positionState = websocketService.getBotState()[symbol].position;
        positionState.currentStopLossPrice = parseFloat(formattedSlPrice);
        positionState.currentTakeProfitPrice = parseFloat(formattedTpPrice);
        positionState.stopLossOrderId = stopLossOrder.orderId;
        positionState.takeProfitOrderId = takeProfitOrder.orderId;

    } catch (error) {
        console.error(colors.red, `  [${symbol}] ❌ ERRO FATAL ao colocar SL/TP iniciais:`, `[${error.code || 'S/C'}] ${error.message}`, colors.reset);
        console.log(colors.yellow, `  [${symbol}] AVISO: Falha ao configurar SL/TP automáticos. Fechando posição imediatamente para segurança.`, colors.reset);
        await closePosition(symbol, 'FAILED_SL_TP_PLACEMENT'); // Fecha a posição para não ficar desprotegida
    }
}

/**
 * Atualiza uma ordem de Stop Loss existente na Binance.
 * Usada para Trailing Stop ou mover o SL para o Break Even.
 * @param {string} symbol - O par de trading.
 * @param {number} quantity - A quantidade da posição.
 * @param {string} side - 'LONG' ou 'SHORT'.
 * @param {number} newStopLossPrice - O novo preço para o Stop Loss.
 * @param {string} oldStopLossOrderId - O ID da ordem de Stop Loss antiga a ser cancelada.
 */
async function updateStopLoss(symbol, quantity, side, newStopLossPrice, oldStopLossOrderId) {
    const orderSideForExit = side === 'LONG' ? 'SELL' : 'BUY';
    const QUANTITY_PRECISION = exchangeRules[symbol].quantityPrecision !== undefined ? exchangeRules[symbol].quantityPrecision : 8;
    const PRICE_PRECISION = exchangeRules[symbol].pricePrecision !== undefined ? exchangeRules[symbol].pricePrecision : 8;
    const formattedNewSL = parseFloat(newStopLossPrice).toFixed(PRICE_PRECISION);

    try {
        // 1. Cancelar a ordem de Stop Loss antiga
        if (oldStopLossOrderId) {
            try {
                await client.futuresCancelOrder({ symbol, orderId: oldStopLossOrderId });
                console.log(colors.red, `  [${symbol}] ↩️ Stop Loss antigo (${oldStopLossOrderId}) CANCELADO.`);
            } catch (cancelError) {
                if (cancelError.code === -2011) { // Erro -2011: Ordem desconhecida ou já cancelada/preenchida
                    console.log(colors.yellow, `  [${symbol}] Aviso: SL antigo (${oldStopLossOrderId}) já cancelado/preenchido (código -2011).`, colors.reset);
                } else {
                    console.error(colors.red, `  [${symbol}] ❌ ERRO ao cancelar SL antigo (${oldStopLossOrderId}):`, cancelError.message, colors.reset);
                    return false; // Retorna false se falhar ao cancelar
                }
            }
        }

        // 2. Colocar uma nova ordem de STOP_MARKET com o novo preço
        const newStopLossOrder = await client.futuresOrder({
            symbol,
            side: orderSideForExit,
            type: 'STOP_MARKET',
            quantity: quantity.toFixed(QUANTITY_PRECISION),
            stopPrice: formattedNewSL,
            closePosition: 'true',
            newClientOrderId: `SL_UPD_${symbol}_${Date.now()}`
        });
        console.log(colors.red, `  [${symbol}] ⬆️ NOVO STOP_LOSS enviado: ${orderSideForExit} ${quantity.toFixed(QUANTITY_PRECISION)} @ StopPrice ${formattedNewSL}`);

        // Atualiza o estado da posição no botState com o novo ID da ordem de SL e o novo preço
        const positionState = websocketService.getBotState()[symbol].position;
        positionState.currentStopLossPrice = parseFloat(formattedNewSL);
        positionState.stopLossOrderId = newStopLossOrder.orderId;
        return true; // Sucesso na atualização

    } catch (error) {
        console.error(colors.red, `  [${symbol}] ❌ ERRO ao atualizar STOP LOSS:`, `[${error.code || 'S/C'}] ${error.message}`, colors.reset);
        console.log(colors.yellow, `  [${symbol}] AVISO: Falha ao mover o SL. Posição pode estar desprotegida ou fechará no SL original/hard stop.`, colors.reset);
        return false; // Falha na atualização
    }
}

/**
 * Tenta abrir uma nova posição de trading no mercado.
 * Realiza verificações de saldo e calcula o tamanho da ordem.
 * @param {string} symbol - O par de trading.
 * @param {object} signal - O sinal de entrada da estratégia (side, strategy, config).
 */
async function openPosition(symbol, signal) {
    const { leverage, marginPercentPerTrade, quoteAsset } = STRATEGY_CONFIG;
    const price = websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice;

    try {
        // Recalcula o saldo disponível ANTES de abrir a ordem.
        const accountInfo = await client.futuresAccountInfo();
        const usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === quoteAsset)?.availableBalance || '0');
        const marginToUse = usdtBalance * (marginPercentPerTrade / 100);

        // Verifica se o valor nocional da ordem é suficiente para a Binance.
        // STRATEGY_CONFIG.minNotionalForNewOrder é configurável.
        if (marginToUse * leverage < STRATEGY_CONFIG.minNotionalForNewOrder) {
            console.log(colors.yellow, `  [${symbol}] AVISO: Saldo insuficiente (${usdtBalance.toFixed(2)} ${quoteAsset}) ou valor da posição calculada (${(marginToUse * leverage).toFixed(2)} USDT) muito baixo para abrir nova posição (mínimo configurado: ${STRATEGY_CONFIG.minNotionalForNewOrder} USDT).`, colors.reset);
            return; // Não prossegue com a ordem se o saldo for baixo
        }

        const positionSizeInUsd = marginToUse * leverage;
        const quantity = positionSizeInUsd / price;
        const formattedQuantity = parseFloat(quantity).toFixed(exchangeRules[symbol].quantityPrecision);

        console.log(colors.green, `  [${symbol}] Tentando abrir posição: ${signal.side} ${formattedQuantity} ${symbol} @ ${price}`);
        const order = await client.futuresOrder({
            symbol,
            side: signal.side === 'LONG' ? 'BUY' : 'SELL',
            type: 'MARKET', // Ordem a mercado para execução imediata
            quantity: formattedQuantity,
        });

        // Atualiza o estado da posição no botState após a ordem principal ser enviada
        const positionState = websocketService.getBotState()[symbol].position;
        positionState.side = signal.side;
        positionState.quantity = parseFloat(order.executedQty);
        positionState.activeStrategy = signal.strategy;
        positionState.activeStrategyConfig = signal.config;
        // Zera IDs e preços para que `manageOpenPosition` saiba que precisa configurá-los
        positionState.stopLossOrderId = null;
        positionState.takeProfitOrderId = null;
        positionState.currentStopLossPrice = 0;
        positionState.currentTakeProfitPrice = 0;

        // Tenta buscar os detalhes exatos da ordem preenchida para preço de entrada e taxa
        const trades = await client.futuresUserTrades({ symbol, orderId: order.orderId });
        if (trades && trades.length > 0) {
            positionState.entryFee = parseFloat(trades[0].commission);
            positionState.entryPrice = parseFloat(trades[0].price);
        } else {
            console.log(colors.yellow, `  [${symbol}] Aviso: Detalhes do trade não disponíveis imediatamente. Usando preço e taxa estimados.`);
            positionState.entryFee = (parseFloat(order.executedQty) * price * STRATEGY_CONFIG.takerFeePercent) / 100;
            positionState.entryPrice = price;
        }

        console.log(colors.green, `  [${symbol}] POSIÇÃO ABERTA: ${positionState.side} ${positionState.quantity.toFixed(exchangeRules[symbol].quantityPrecision)} @ ${positionState.entryPrice.toFixed(exchangeRules[symbol].pricePrecision)} (${positionState.activeStrategy})`);
        
        // As ordens de SL/TP iniciais serão colocadas no PRÓXIMO ciclo de `manageOpenPosition`.
        // Isso evita "race conditions" e garante que a ordem principal já esteja totalmente preenchida.
        console.log(colors.yellow, `  [${symbol}] Ordens SL/TP iniciais serão configuradas no próximo ciclo de gerenciamento.`, colors.reset);

    } catch (error) { handleApiError(error); }
}

/**
 * Fecha uma posição aberta no mercado.
 * Cancela ordens pendentes de SL/TP antes de enviar a ordem de fechamento.
 * @param {string} symbol - O par de trading.
 * @param {string} reason - O motivo do fechamento.
 */
async function closePosition(symbol, reason) {
    const positionState = websocketService.getBotState()[symbol].position;
    try {
        // 1. Cancelar quaisquer ordens de SL/TP pendentes (se existirem IDs)
        if (positionState.stopLossOrderId) {
            try {
                await client.futuresCancelOrder({ symbol, orderId: positionState.stopLossOrderId });
                console.log(colors.red, `  [${symbol}] ↩️ Stop Loss pendente (${positionState.stopLossOrderId}) CANCELADO.`);
            } catch (cancelError) {
                if (cancelError.code === -2011) console.log(colors.yellow, `  [${symbol}] Aviso: SL pendente (${positionState.stopLossOrderId}) já cancelado/preenchido (código -2011).`, colors.reset);
                else console.error(colors.red, `  [${symbol}] ❌ ERRO ao cancelar SL (${positionState.stopLossOrderId}):`, cancelError.message, colors.reset);
            }
        }
        if (positionState.takeProfitOrderId) {
            try {
                await client.futuresCancelOrder({ symbol, orderId: positionState.takeProfitOrderId });
                console.log(colors.green, `  [${symbol}] ↩️ Take Profit pendente (${positionState.takeProfitOrderId}) CANCELADO.`);
            } catch (cancelError) {
                if (cancelError.code === -2011) console.log(colors.yellow, `  [${symbol}] Aviso: TP pendente (${positionState.takeProfitOrderId}) já cancelado/preenchido (código -2011).`, colors.reset);
                else console.error(colors.red, `  [${symbol}] ❌ ERRO ao cancelar TP (${positionState.takeProfitOrderId}):`, cancelError.message, colors.reset);
            }
        }

        // 2. Envia a ordem de fechamento da posição (a mercado, reduceOnly)
        // Garante que a quantidade seja positiva antes de enviar a ordem
        const quantityToClose = Math.abs(positionState.quantity);
        if (quantityToClose <= 0) {
            console.log(colors.yellow, `  [${symbol}] Aviso: Quantidade para fechar posição é zero ou negativa. Nenhuma ordem de fechamento enviada.`, colors.reset);
            websocketService.getBotState()[symbol].position = { side: 'NONE', stopLossOrderId: null, takeProfitOrderId: null, currentStopLossPrice: 0, currentTakeProfitPrice: 0 };
            return;
        }

        const order = await client.futuresOrder({
            symbol,
            side: positionState.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: quantityToClose.toFixed(exchangeRules[symbol].quantityPrecision),
            reduceOnly: 'true', // Essencial para garantir que apenas fecha a posição
        });

        console.log(colors.yellow, `  [${symbol}] POSIÇÃO FECHADA: ${positionState.side} ${quantityToClose.toFixed(exchangeRules[symbol].quantityPrecision)} @ ${websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice.toFixed(exchangeRules[symbol].pricePrecision)}. Motivo: ${reason}`);

        // Limpa o estado da posição e IDs de ordens
        websocketService.getBotState()[symbol].position = { side: 'NONE', stopLossOrderId: null, takeProfitOrderId: null, currentStopLossPrice: 0, currentTakeProfitPrice: 0 };

    } catch (error) { handleApiError(error); }
}

/**
 * Função principal que inicializa e executa o bot.
 */
async function main() {
    showHeader(`Bot MTA v5 - [${STRATEGY_CONFIG.symbolsToWatch.join(', ')}]`);
    try {
        console.log('Buscando regras dos ativos...');
        const exchangeInfo = await client.futuresExchangeInfo();
        for (const rule of exchangeInfo.symbols) {
            // Captura pricePrecision para formatar preços de SL/TP corretamente
            exchangeRules[rule.symbol] = { quantityPrecision: rule.quantityPrecision, pricePrecision: rule.pricePrecision };
        }

        console.log('Verificando saldo inicial...');
        const accountInfo = await client.futuresAccountInfo();
        const usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === STRATEGY_CONFIG.quoteAsset)?.availableBalance || '0');
        
        // O bot AGORA SEMPRE CONTINUA, mesmo com saldo baixo.
        // Apenas um log de ATENÇÃO é exibido.
        if (usdtBalance < STRATEGY_CONFIG.minInitialBalance) { // Usando minInitialBalance da config.json
            console.log(colors.red, `❌ ATENÇÃO: Saldo inicial de ${STRATEGY_CONFIG.quoteAsset} (${usdtBalance.toFixed(2)}) é muito baixo. O bot NÃO ABRIRÁ NOVAS POSIÇÕES até que o saldo aumente, mas CONTINUARÁ MONITORANDO e GERENCIANDO POSIÇÕES ATIVAS.`, colors.reset);
        } else {
            console.log(colors.green, `✅ Saldo de margem inicial: ${usdtBalance.toFixed(2)} ${STRATEGY_CONFIG.quoteAsset}`);
        }

        console.log('Iniciando módulo de IA...');
        await aiModule.init();

        console.log('\n[Bot] Buscando dados históricos via HTTP para treinamento inicial da IA e pré-aquecimento das estratégias...');
        dataHttp.setBinanceClient(client);
        
        // Objeto temporário para acumular os dados históricos que serão passados para o websocketService
        const historicalDataForBotState = {}; 

        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            // Inicializa a estrutura completa para o símbolo no botState, incluindo campos de posição para SL/TP
            historicalDataForBotState[symbol] = { 
                data: {}, 
                position: { 
                    side: 'NONE', 
                    entryPrice: 0, 
                    quantity: 0, 
                    entryFee: 0, 
                    activeStrategy: null, 
                    activeStrategyConfig: null,
                    currentStopLossPrice: 0, 
                    currentTakeProfitPrice: 0, 
                    stopLossOrderId: null,    
                    takeProfitOrderId: null   
                } 
            }; 
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                const historicalData = await dataHttp.getHistoricalData(symbol, timeframe);
                
                if (historicalData && historicalData.length > 0) {
                    aiModule.collectHistoricalDataFromHttp(symbol, timeframe, historicalData);
                    historicalDataForBotState[symbol].data[timeframe] = {
                        candles: historicalData,
                        // Os últimos indicadores da última vela são um objeto completo com rsi, ema, etc.
                        indicators: historicalData[historicalData.length - 1], 
                        lastPrice: historicalData[historicalData.length - 1].close,
                        isReady: true // Indica que este timeframe está pronto para uso de estratégia
                    };
                    console.log(colors.green, `  [Bot] Histórico (${historicalData.length} velas) para ${symbol} - [${timeframe}] PRÉ-AQUECIDO via HTTP.`);
                } else {
                    console.log(colors.yellow, `  [Bot] Nenhum histórico HTTP para ${symbol} - [${timeframe}]. Ele aquecerá via WebSocket.`, colors.reset);
                    historicalDataForBotState[symbol].data[timeframe] = {
                        candles: [], indicators: {}, lastPrice: 0, isReady: false
                    };
                }
            }
        }
        console.log('[Bot] Coleta de dados históricos HTTP para IA e pré-aquecimento concluída.');


        console.log('\nIniciando serviço de WebSockets e monitoramento em tempo real...');
        // Passa o historicalDataForBotState (já com as estruturas de posição) para o websocketService
        // e o accountInfo para que ele possa sincronizar posições abertas na Binance.
        botState = await websocketService.initialize(client, historicalDataForBotState, onNewCandleProcessed, accountInfo);


        console.log(colors.yellow, "\nO bot está operando. Pressione CTRL + C para parar.", colors.reset);
        console.log(colors.yellow, "A IA começará a treinar periodicamente com os dados coletados.");

        if (STRATEGY_CONFIG.aiModule.enabled) {
            setInterval(async () => {
                const allTimeframesHaveEnoughDataForAI = STRATEGY_CONFIG.symbolsToWatch.every(symbol =>
                    STRATEGY_CONFIG.timeframesToWatch.every(tf =>
                        aiModule.getCollectedDataCount(symbol, tf) >= aiModule.aiModel.minDataForTraining
                    )
                );
                
                if (allTimeframesHaveEnoughDataForAI) {
                    console.log(colors.yellow, "\nIniciando treinamento da IA...");
                    await aiModule.train();
                    console.log(colors.yellow, "Treinamento da IA concluído.");
                } else {
                    console.log(colors.gray, "🤖 IA: Histórico insuficiente em um ou mais timeframes para iniciar o treinamento.", colors.reset);
                }
            }, STRATEGY_CONFIG.aiModule.trainingIntervalMs || 3600000);
        } else {
            console.log(colors.yellow, "Módulo de IA desabilitado na configuração. O treinamento automático não será iniciado.", colors.reset);
        }

    } catch (error) {
        handleApiError(error);
        process.exit(1);
    }
}

function showHeader(title) { console.clear(); console.log(colors.cyan, `================== ${title} ==================\n`, colors.reset); }
function handleApiError(error) { console.error(colors.red, '\n❌ Erro na API:', `[${error.code || 'S/C'}] ${error.message}`, colors.reset); }
function gracefulShutdown() { console.log(colors.yellow, "\nEncerrando bot..."); process.exit(0); }

process.on('SIGINT', gracefulShutdown);
main();