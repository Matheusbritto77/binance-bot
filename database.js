const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const log = require('./log');

const MONGO_URL = 'mongodb://mongo:mogo@168.231.95.211:27017';
const DB_NAME = 'binance_bot';

// FLAG: Força uso exclusivo do MongoDB quando conectado
const FORCE_MONGO_ONLY = true;

let client = null;
let db = null;

async function connect() {
    try {
        client = new MongoClient(MONGO_URL);
        await client.connect();
        db = client.db(DB_NAME);
        log('success', '✅ Conectado ao MongoDB');
        if (FORCE_MONGO_ONLY) {
            log('warning', '🚫 [FORCE_MONGO_ONLY] Modo exclusivo MongoDB ativado - JSON será ignorado');
        }
        return true;
    } catch (err) {
        log('error', '❌ Falha ao conectar ao MongoDB:', err.message);
        db = null;
        return false;
    }
}

function isConnected() {
    return !!db;
}

function getJsonFilePath(collection, symbol = null, timeframe = null) {
    let file;
    switch (collection) {
        case 'ai_data':
            file = path.join(__dirname, 'ai_data', 'ai_data.json');
            break;
        case 'ai_model':
            file = path.join(__dirname, 'ai_data', 'ai_model.json');
            break;
        case 'ai_stats':
            file = path.join(__dirname, 'ai_data', 'ai_stats.json');
            break;
        case 'historical_data':
            file = path.join(__dirname, 'historical_data', `historical_data_${symbol}_${timeframe}.json`);
            break;
        case 'raw_candles':
            file = path.join(__dirname, 'raw_candles', `raw_candles_${symbol}_${timeframe}.json`);
            break;
        case 'realtime_data':
            file = path.join(__dirname, 'realtime_data', `realtime_${symbol}_${timeframe}.json`);
            break;
        case 'update_status':
            file = path.join(__dirname, 'update_status.json');
            break;
        default:
            file = path.join(__dirname, `${collection}.json`);
    }
    return file;
}

async function loadData(collection, symbol = null, timeframe = null, query = {}) {
    if (db) {
        try {
            let mongoQuery = { ...query };
            if (symbol && timeframe) {
                // Para dados específicos por symbol/timeframe, usa uma chave composta
                mongoQuery._id = `${collection}_${symbol}_${timeframe}`;
            } else {
                // Para dados gerais (como ai_data, ai_model, etc), usa apenas o nome da collection
                mongoQuery._id = collection;
            }
            const data = await db.collection('bot_data').findOne(mongoQuery);
            if (data && data.data !== undefined) {
                log('info', `📊 [MongoDB] Carregado de ${collection}${symbol ? ` (${symbol}-${timeframe})` : ''}`);
                return data.data;
            } else {
                log('info', `📊 [MongoDB] Dados não encontrados para ${collection}${symbol ? ` (${symbol}-${timeframe})` : ''}`);
            }
        } catch (err) {
            log('error', '❌ Erro ao buscar no MongoDB:', err.message);
        }
    }
    
    // Só usa JSON se FORCE_MONGO_ONLY estiver desabilitado OU se MongoDB não estiver conectado
    if (!FORCE_MONGO_ONLY || !db) {
        const file = getJsonFilePath(collection, symbol, timeframe);
        if (fs.existsSync(file)) {
            log('info', `📁 [JSON] Carregado de ${file}`);
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
        log('info', `📁 [JSON] Arquivo não encontrado: ${file}`);
    } else {
        log('warning', `🚫 [FORCE_MONGO_ONLY] Ignorando JSON para ${collection}${symbol ? ` (${symbol}-${timeframe})` : ''}`);
    }
    return null;
}

async function saveData(collection, data, symbol = null, timeframe = null, query = {}) {
    if (db) {
        try {
            let documentId;
            if (symbol && timeframe) {
                // Para dados específicos por symbol/timeframe, usa uma chave composta
                documentId = `${collection}_${symbol}_${timeframe}`;
            } else {
                // Para dados gerais (como ai_data, ai_model, etc), usa apenas o nome da collection
                documentId = collection;
            }
            await db.collection('bot_data').updateOne(
                { _id: documentId },
                { $set: { data, updatedAt: new Date() } },
                { upsert: true }
            );
            log('success', `📊 [MongoDB] Salvo em ${collection}${symbol ? ` (${symbol}-${timeframe})` : ''}`);
            return true;
        } catch (err) {
            log('error', '❌ Erro ao salvar no MongoDB:', err.message);
        }
    }
    
    // Só usa JSON se FORCE_MONGO_ONLY estiver desabilitado OU se MongoDB não estiver conectado
    if (!FORCE_MONGO_ONLY || !db) {
        const file = getJsonFilePath(collection, symbol, timeframe);
        try {
            // Garante diretório
            const dir = path.dirname(file);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
            log('success', `📁 [JSON] Salvo em ${file}`);
            return true;
        } catch (err) {
            log('error', '❌ Erro ao salvar JSON:', err.message);
            return false;
        }
    } else {
        log('warning', `🚫 [FORCE_MONGO_ONLY] Ignorando salvamento JSON para ${collection}${symbol ? ` (${symbol}-${timeframe})` : ''}`);
        return false;
    }
}

/**
 * Salva múltiplos documentos em lote no MongoDB (bulkWrite). Fallback para JSON se necessário.
 * @param {Array<{collection: string, data: any, symbol?: string, timeframe?: string}>} batchArray
 * @returns {Promise<boolean>} true se sucesso
 */
async function saveDataBatch(batchArray) {
    if (db) {
        try {
            const operations = batchArray.map(item => {
                let documentId;
                if (item.symbol && item.timeframe) {
                    documentId = `${item.collection}_${item.symbol}_${item.timeframe}`;
                } else {
                    documentId = item.collection;
                }
                return {
                    updateOne: {
                        filter: { _id: documentId },
                        update: { $set: { data: item.data, updatedAt: new Date() } },
                        upsert: true
                    }
                };
            });
            await db.collection('bot_data').bulkWrite(operations);
            log('success', `📊 [MongoDB] Salvo em lote (${batchArray.length} documentos)`);
            return true;
        } catch (err) {
            log('error', '❌ Erro ao salvar em lote no MongoDB:', err.message);
        }
    }
    // Fallback para JSON: salva cada item individualmente
    if (!FORCE_MONGO_ONLY || !db) {
        let allOk = true;
        for (const item of batchArray) {
            const file = getJsonFilePath(item.collection, item.symbol, item.timeframe);
            try {
                const dir = path.dirname(file);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(file, JSON.stringify(item.data, null, 2));
                log('success', `📁 [JSON] Salvo em ${file}`);
            } catch (err) {
                log('error', '❌ Erro ao salvar JSON:', err.message);
                allOk = false;
            }
        }
        return allOk;
    } else {
        log('warning', '🚫 [FORCE_MONGO_ONLY] Ignorando salvamento JSON em lote');
        return false;
    }
}

async function close() {
    if (client) await client.close();
    db = null;
}

module.exports = { connect, isConnected, loadData, saveData, saveDataBatch, close, FORCE_MONGO_ONLY }; 