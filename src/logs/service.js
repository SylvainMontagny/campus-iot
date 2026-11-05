const MAX_LOG_ENTRIES = 300;

// Application logs: stores bounded MQTT log and raw-message histories and forwards log entries to the caller.
function createLogService({ onLog = () => {} } = {}) {
  let sequence = 0;
  let rawSequence = 0;
  const logs = [];
  const rawMessages = [];

  // MQTT diagnostics: stores the latest received message for the raw-message panel.
  function addRawMessage(topic, payload) {
    rawMessages.push({ id: ++rawSequence, timestamp: new Date().toISOString(), topic, payload: payload.toString("utf8") });
    if (rawMessages.length > MAX_LOG_ENTRIES) rawMessages.shift();
  }

  // MQTT diagnostics API: returns raw messages newer than the caller's last sequence number.
  function getRawMessages(after = 0) {
    return rawMessages.filter((entry) => entry.id > after);
  }

  // MQTT diagnostics: stores a bounded log entry and forwards it to the application logger.
  function addLog(level, message, details) {
    const entry = { id: ++sequence, timestamp: new Date().toISOString(), level, message };
    if (details !== undefined) entry.details = details;
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) logs.shift();
    onLog(entry);
  }

  // MQTT diagnostics API: returns application log entries newer than the caller's sequence number.
  function getLogs(after = 0) {
    return logs.filter((entry) => entry.id > after);
  }

  return { addRawMessage, getRawMessages, addLog, getLogs };
}

module.exports = { createLogService };
