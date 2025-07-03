const levels = {
  info: console.info,
  success: console.log,
  warning: console.warn,
  error: console.error,
  debug: console.debug,
};

function log(level, message, data = {}) {
  const logFn = levels[level] || console.log;
  let msg = message;
  if (level === 'info') {
    // Remove quebras de linha e compacta
    msg = msg.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const dataStr = Object.keys(data).length ? ' | ' + JSON.stringify(data) : '';
  logFn(`[${level.toUpperCase()}] ${msg}${dataStr}`);
}

module.exports = log; 