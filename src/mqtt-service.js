const mqtt = require("mqtt");
const { processRestApiBacnet } = require("./restapi-bacnet");
const { processBacnet } = require("./bacnet-native");
const { prepareDownlink, protocolLabel } = require("./downlink");

const MAX_LOG_ENTRIES = 300;
const RECONNECT_PERIOD_MS = 20000;
// Our own downlink publications come back when subscribed to a wildcard topic.
const DOWNLINK_TOPIC = /(\/down\/(push|replace)|\/command\/down|\/downlink)$/;
const NETWORKS = {
  tts: { uplinkSuffix: "/up", downlinkSuffix: "/down" },
  chirpstack: { uplinkSuffix: "/event/up", downlinkSuffix: "/command/down" },
  actility: { uplinkSuffix: "/uplink", downlinkSuffix: "/downlink" }
};

function mapIncomingPacket(topic, rawPayload, deviceList) {
  let payload;
  try {
    payload = Buffer.isBuffer(rawPayload) ? JSON.parse(rawPayload.toString("utf8")) :
      typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  } catch (error) {
    return { error: `Invalid JSON MQTT payload: ${error.message}` };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Invalid MQTT payload: expected a JSON object" };
  }

  let networkServer;
  if (Object.hasOwn(payload, "deviceInfo")) networkServer = "chirpstack";
  if (Object.hasOwn(payload, "end_device_ids")) networkServer = "tts";
  if (Object.hasOwn(payload, "DevEUI_uplink")) networkServer = "actility";
  if (!networkServer) return { error: "Unknown network server payload format" };

  if (networkServer === "actility" && Object.hasOwn(payload, "DevEUI_notification")) {
    return { ignored: true };
  }
  if (networkServer === "actility" && Object.hasOwn(payload, "DevEUI_downlink_Rejected")) {
    return { error: "Actility : Downlink Message Rejected" };
  }

  let deviceName;
  let deviceEui;
  let devicePayload;
  let topicDownlink;
  if (networkServer === "tts") {
    deviceName = payload.end_device_ids?.device_id;
    deviceEui = payload.end_device_ids?.dev_eui;
    topicDownlink = topic.replace(NETWORKS.tts.uplinkSuffix, "") + NETWORKS.tts.downlinkSuffix;
    if (!payload.uplink_message || !Object.hasOwn(payload.uplink_message, "decoded_payload")) {
      return { error: `${deviceName} : No payload decoder configured on the Network Server` };
    }
    devicePayload = payload.uplink_message.decoded_payload;
  } else if (networkServer === "chirpstack") {
    if (payload.fPort === 0) return { ignored: true };
    deviceName = payload.deviceInfo?.deviceName;
    deviceEui = payload.deviceInfo?.devEui;
    topicDownlink = topic.replace(NETWORKS.chirpstack.uplinkSuffix, "") + NETWORKS.chirpstack.downlinkSuffix;
    if (!Object.hasOwn(payload, "object")) {
      return { error: `${deviceName} : No payload decoder configured on the Network Server` };
    }
    devicePayload = payload.object;
  } else {
    const uplink = payload.DevEUI_uplink;
    deviceName = uplink?.CustomerData?.name;
    deviceEui = uplink?.DevEUI;
    topicDownlink = topic.replace(NETWORKS.actility.uplinkSuffix, "") + NETWORKS.actility.downlinkSuffix;
    if (!uplink || !Object.hasOwn(uplink, "payload")) {
      return { error: `${deviceName} : No payload decoder configured on the Network Server` };
    }
    devicePayload = uplink.payload;
  }

  const match = String(deviceName).match(/^(.*)-(\d+)$/);
  if (!match) {
    return {
      error: `Error: Device Name (${deviceName}) does not respect *xxx - num* format`,
      details: { errorType: "deviceName", value: deviceName }
    };
  }
  const deviceType = match[1];
  const deviceNumber = Number.parseInt(match[2], 10);
  if (deviceNumber === 0) {
    return {
      error: `Error: Device Num is 0 is not allowed (${deviceName})`,
      details: { errorType: "deviceName", value: deviceName }
    };
  }
  if (!deviceList[deviceType]) {
    return {
      error: `Error: Device Type does not belong to the Device List (${deviceName})`,
      details: { errorType: "deviceName", value: deviceName }
    };
  }

  const sourceDevice = deviceList[deviceType];
  if (deviceNumber > sourceDevice.identity.maxDevNum) {
    return {
      error: `Error: Device number is too high (${deviceName})`,
      details: { errorType: "deviceName", value: deviceName }
    };
  }

  const device = JSON.parse(JSON.stringify(sourceDevice));
  device.identity.deviceName = deviceName;
  device.identity.deviceType = deviceType;
  device.identity.deviceNum = deviceNumber;
  device.identity.devEUI = deviceEui;
  device.mqtt ||= {};
  device.mqtt.topicDownlink = topicDownlink;

  for (const [objectName, object] of Object.entries(device.bacnet.objects)) {
    if (object.assignementMode === "auto") {
      if (object.objectType === "analogValue") {
        object.instanceNum += device.bacnet.offsetAV + device.bacnet.instanceRangeAV * deviceNumber;
      } else if (object.objectType === "binaryValue") {
        object.instanceNum += device.bacnet.offsetBV + device.bacnet.instanceRangeBV * deviceNumber;
      } else {
        return { error: `Object type of ${objectName} is unknown : ${object.objectType}` };
      }
    }

    object.objectName = `${deviceName}-${objectName}-${object.instanceNum}`;
    if (object.dataDirection === "uplink") {
      const keys = String(object.lorawanPayloadName || "").split(/[.\[\]]/).filter((key) => key !== "");
      object.value = keys.reduce((value, key) => value?.[key], devicePayload);
    }
    if (object.value === undefined || typeof object.value === "object") {
      return { error: `Device : ${device.identity.deviceName} - Object : ${objectName} - Wrong Payload decoder or Wrong Device description` };
    }

    if (device.controller.protocol === "bacnet") {
      if (object.objectType === "analogValue") object.objectType = 2;
      if (object.objectType === "binaryValue") object.objectType = 5;
      device.bacnet.uplinkKeys = Object.entries(device.bacnet.objects)
        .filter(([, bacnetObject]) => bacnetObject.dataDirection === "uplink")
        .map(([key]) => key);
    }
  }

  device.transmitTime = Date.now();
  device.influxdb = { source: "uplink" };
  return { device };
}

function createMqttService({ getDeviceList, onLog = () => {}, clientFactory = mqtt.connect, restApiBacnetHandler = processRestApiBacnet, bacnetHandler = processBacnet } = {}) {
  const protocolHandlers = { restAPIBacnet: restApiBacnetHandler, bacnet: bacnetHandler };
  const previousValues = {};
  let client = null;
  let state = "disconnected";
  let settings = null;
  let sequence = 0;
  const logs = [];
  const rawMessages = [];
  let rawSequence = 0;

  function addRawMessage(topic, payload) {
    rawMessages.push({ id: ++rawSequence, timestamp: new Date().toISOString(), topic, payload: payload.toString("utf8") });
    if (rawMessages.length > MAX_LOG_ENTRIES) rawMessages.shift();
  }

  function getRawMessages(after = 0) {
    return rawMessages.filter((entry) => entry.id > after);
  }
  function addLog(level, message, details) {
    const entry = { id: ++sequence, timestamp: new Date().toISOString(), level, message };
    if (details !== undefined) entry.details = details;
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) logs.shift();
    onLog(entry);
  }

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

  function getStatus() {
    return {
      state,
      server: settings?.server || "",
      port: settings?.port || "",
      topic: settings?.topic || ""
    };
  }

  function getLogs(after = 0) {
    return logs.filter((entry) => entry.id > after);
  }

  function publish(topic, payload) {
    return new Promise((resolve, reject) => {
      if (!client || state !== "connected") {
        reject(new Error("MQTT client is not connected"));
        return;
      }
      client.publish(topic, JSON.stringify(payload), (error) => (error ? reject(error) : resolve()));
    });
  }

  function disconnect() {
    const activeClient = client;
    client = null;
    state = "disconnected";
    settings = null;
    if (activeClient) activeClient.end(true);
    addLog("info", "Disconnected from MQTT broker.");
    return getStatus();
  }

  function connect(options) {
    const server = String(options?.server || "").trim();
    const port = Number(options?.port);
    const topic = String(options?.topic || "").trim();
    if (!server || !Number.isInteger(port) || port < 1 || port > 65535 || !topic) {
      throw new Error("Server, a valid port, and topic are required.");
    }

    if (client) disconnect();
    settings = { server, port, topic };
    state = "connecting";
    addLog("info", `Connecting to MQTT broker ${server}:${port}.`);

    try {
      const activeClient = clientFactory({
        host: server,
        port,
        protocol: "mqtt",
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
          const deviceList = await getDeviceList();
          const result = mapIncomingPacket(receivedTopic, payload, deviceList);
          if (result.error) addLog("error", result.error, result.details);
          else if (result.device) {
            const debug = result.device.controller?.debug || [];
            // Errors are always shown; "all" enables every event category but not the device object prints.
            const deviceLog = (level, message, details, category) => {
              if (level === "error" || debug.includes(category) || (level !== "output" && debug.includes("all"))) addLog(level, message, details);
            };
            deviceLog("output", `Device object after MQTT reception:\n${JSON.stringify(result.device, null, 2)}`, result.device, "deviceMqtt");
            const name = result.device.identity.deviceName;
            deviceLog("output", `previousValues of ${name} after MQTT reception:\n${JSON.stringify(previousValues[name] ?? null, null, 2)}`, structuredClone(previousValues[name] ?? null), "previousValuesMqtt");
            const protocolHandler = protocolHandlers[result.device.controller?.protocol];
            if (protocolHandler) {
              const outcome = await protocolHandler(result.device, { previousValues, log: deviceLog });
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

  return { connect, disconnect, getStatus, getLogs, getRawMessages, publish };
}

module.exports = { createMqttService, mapIncomingPacket };