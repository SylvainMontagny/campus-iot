const mqtt = require("mqtt");
const net = require("node:net");
const { processRestApiBacnet } = require("../bms-connections/adapters/distech-rest/device-communication");
const { processBacnet } = require("../bms-connections/adapters/bacnet/device-communication");
const { prepareDownlink, protocolLabel } = require("../lorawan-to-bacnet/downlink");
const { createLogService } = require("../logs/service");
const { mapIncomingPacket } = require("../lorawan-to-bacnet/payload-mapping");

const RECONNECT_PERIOD_MS = 20000;
const SECURE_MQTT_PORTS = [8883, 8884];
// Our own downlink publications come back when subscribed to a wildcard topic.
const DOWNLINK_TOPIC = /(\/down\/(push|replace)|\/command\/down|\/downlink)$/;
// MQTT service: manages broker connection, device processing, logs, and protocol-specific downlink dispatch.
function createMqttService({ getDeviceProfiles, getScheduleValues, onLog = () => {}, clientFactory = mqtt.connect, restApiBacnetHandler = processRestApiBacnet, bacnetHandler = processBacnet } = {}) {
  const protocolHandlers = { restAPIBacnet: restApiBacnetHandler, bacnet: bacnetHandler };
  const previousValues = {};
  let client = null;
  let state = "disconnected";
  let settings = null;
  const logService = createLogService({ onLog });
  const { addRawMessage, getRawMessages, addLog, getLogs } = logService;

  // MQTT downlink processing: prepares and publishes a network-server message after BMS processing succeeds.
  async function sendDownlink(device, deviceLog) {
    const name = device.identity.deviceName;
    const message = prepareDownlink(device, previousValues, deviceLog);
    if (!message) return;
    try {
      await publish(message.topic, message.payload);
    } catch (error) {
      addLog("error", `${name}: Downlink publication failed: ${error.message}`);
      return;
    }
    deviceLog("info", `${name} (${protocolLabel(device)}): TX time = ${Date.now() - device.transmitTime}ms`, undefined, "txTime");
  }

  // MQTT status API: returns the broker state and non-secret connection details for the UI.
  function getStatus() {
    return {
      state,
      server: settings?.server || "",
      port: settings?.port || "",
      topic: settings?.topic || ""
    };
  }

  // MQTT downlink processing: publishes a JSON payload only while the broker is connected.
  function publish(topic, payload) {
    return new Promise((resolve, reject) => {
      if (!client || state !== "connected") {
        reject(new Error("MQTT client is not connected"));
        return;
      }
      client.publish(topic, JSON.stringify(payload), (error) => (error ? reject(error) : resolve()));
    });
  }

  // MQTT connection management: closes the active broker client and clears its connection state.
  function disconnect() {
    const activeClient = client;
    client = null;
    state = "disconnected";
    settings = null;
    if (activeClient) activeClient.end(true);
    addLog("info", "Disconnected from MQTT broker.");
    return getStatus();
  }

  // MQTT connection management: validates settings, subscribes to uplinks, and dispatches device messages.
  function connect(options) {
    const server = String(options?.server || "").trim();
    const port = Number(options?.port);
    const topic = String(options?.topic || "").trim();
    if (!server || !Number.isInteger(port) || port < 1 || port > 65535 || !topic) {
      throw new Error("Server, a valid port, and topic are required.");
    }

    if (client) disconnect();
    settings = { server, port, topic };
    // Brokers listening on the standard MQTT-over-TLS ports require an encrypted connection.
    const secure = SECURE_MQTT_PORTS.includes(port);
    state = "connecting";
    addLog("info", `Connecting to MQTT broker ${server}:${port}${secure ? " (TLS)" : ""}.`);

    try {
      const activeClient = clientFactory({
        host: server,
        port,
        protocol: secure ? "mqtts" : "mqtt",
        servername: secure && !net.isIP(server) ? server : undefined,
        username: String(options.username || ""),
        password: String(options.password || ""),
        reconnectPeriod: RECONNECT_PERIOD_MS,
        connectTimeout: 10000
      });
      client = activeClient;

      activeClient.on("connect", () => {
        if (client !== activeClient) return;
        activeClient.subscribe(topic, (error) => {
          if (client !== activeClient) return;
          if (error) {
            state = "error";
            addLog("error", `MQTT topic subscription failed: ${error.message}`);
            return;
          }
          state = "connected";
          addLog("info", `Connected to MQTT broker and subscribed to ${topic}.`);
        });
      });
      activeClient.on("message", async (receivedTopic, payload) => {
        if (client !== activeClient) return;
        addRawMessage(receivedTopic, payload);
        if (DOWNLINK_TOPIC.test(receivedTopic)) return;
        try {
          const deviceProfiles = await getDeviceProfiles();
          const result = mapIncomingPacket(receivedTopic, payload, deviceProfiles);
          if (result.error) addLog("error", result.error, result.details);
          else if (result.device) {
            const debug = result.device.controller?.debug || [];
            // Errors are always shown; "all" enables every event category but not the device object prints.
            // MQTT diagnostics: applies the device profile's debug categories to messages from one uplink.
            const deviceLog = (level, message, details, category) => {
              if (level === "error" || debug.includes(category) || (level !== "output" && debug.includes("all"))) addLog(level, message, details);
            };
            deviceLog("output", `Device object after MQTT reception:\n${JSON.stringify(result.device, null, 2)}`, result.device, "deviceMqtt");
            const name = result.device.identity.deviceName;
            deviceLog("output", `previousValues of ${name} after MQTT reception:\n${JSON.stringify(previousValues[name] ?? null, null, 2)}`, structuredClone(previousValues[name] ?? null), "previousValuesMqtt");
            const protocolHandler = protocolHandlers[result.device.controller?.protocol];
            if (Object.keys(result.device.bacnet.objects).length === 0) {
              addLog("warning", `${name}: Device profile '${result.device.identity.deviceProfile}' has no association between LoRa payload and BACnet object`);
            } else if (protocolHandler) {
              const outcome = await protocolHandler(result.device, { previousValues, log: deviceLog, getInitialValues: getScheduleValues });
              if (outcome?.ok) await sendDownlink(result.device, deviceLog);
            }
          }
        } catch (error) {
          addLog("error", error.message || String(error));
        }
      });
      activeClient.on("error", (error) => {
        if (client !== activeClient) return;
        state = "error";
        addLog("error", error.message || String(error));
      });
      activeClient.on("close", () => {
        if (client !== activeClient) return;
        // The mqtt client keeps retrying until disconnect() is called.
        state = "connecting";
        addLog("warning", `MQTT connection closed. Reconnecting in ${RECONNECT_PERIOD_MS / 1000}s.`);
      });
    } catch (error) {
      client = null;
      state = "error";
      addLog("error", error.message || String(error));
      throw error;
    }

    return getStatus();
  }

  // MQTT device state: clears cached values when a device profile configuration changes.
  function clearPreviousValues(deviceProfile) {
    for (const [deviceName, entry] of Object.entries(previousValues)) {
      if (entry.identity?.deviceProfile === deviceProfile) delete previousValues[deviceName];
    }
  }

  // MQTT device state API: returns copies of cached device values for the selected profile.
  function getPreviousValues(deviceProfile) {
    return Object.values(previousValues)
      .filter((entry) => entry.identity?.deviceProfile === deviceProfile)
      .map((entry) => structuredClone(entry));
  }

  return { connect, disconnect, getStatus, getLogs, getRawMessages, publish, clearPreviousValues, getPreviousValues, log: addLog };
}

module.exports = { createMqttService };