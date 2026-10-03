const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateConfig } = require("./src/config-validation");
const { createDefaultConfig } = require("./src/default-config");
const { createMqttService } = require("./src/mqtt-service");

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, "data");
const mqttService = createMqttService({
  getDeviceList: async () => (await readConfig()).deviceList
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function readConfig(directory = dataDirectory) {
  const deviceListPath = path.join(directory, "deviceList.json");
  let savedData;
  try {
    savedData = JSON.parse(await fs.readFile(deviceListPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return createDefaultConfig();
  }

  const config = savedData.deviceList
    ? { ...createDefaultConfig(), ...savedData }
    : { ...createDefaultConfig(), deviceList: savedData.deviceList || savedData };

  const namedConnections = new Map();
  for (const [deviceName, device] of Object.entries(config.deviceList)) {
    const profileName = device.controller?.connectionName?.trim();
    if (!profileName) continue;
    const settings = inferConnectionSettings(device);
    const priorSettings = namedConnections.get(profileName);
    if (priorSettings && JSON.stringify(priorSettings) !== JSON.stringify(settings)) {
      throw new Error(`Device entries assigned to '${profileName}' contain different connection settings`);
    }
    namedConnections.set(profileName, settings);
    config.deviceConnections[deviceName] = profileName;
  }
  if (namedConnections.size) {
    config.connections = Object.fromEntries(namedConnections);
    for (const deviceName of Object.keys(config.deviceList)) config.deviceConnections[deviceName] ||= "";
  } else {
    const settingsToName = new Map();
    config.deviceConnections = {};
    for (const [deviceName, device] of Object.entries(config.deviceList)) {
      const settings = inferConnectionSettings(device);
      const settingsKey = JSON.stringify(settings);
      if (!settingsToName.has(settingsKey)) {
        const profileName = `Connection ${settingsToName.size + 1}`;
        settingsToName.set(settingsKey, profileName);
        config.connections[profileName] = settings;
      }
      config.deviceConnections[deviceName] = settingsToName.get(settingsKey);
    }
  }
  config.deviceConnections ||= {};
  for (const [deviceName, device] of Object.entries(config.deviceList)) {
    device.controller ||= {};
    const connectionName = config.deviceConnections[deviceName] || device.controller.connectionName || "";
    config.deviceConnections[deviceName] = connectionName;
    device.controller.connectionName = connectionName;
  }
  return config;
}

async function writeConfig(config, directory = dataDirectory) {
  const deviceListPath = path.join(directory, "deviceList.json");
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomically(deviceListPath, config.deviceList);
  // Informational snapshot only: readConfig rebuilds connections from deviceList.json.
  await writeJsonAtomically(path.join(directory, "connections.json"), {
    connections: config.connections || {},
    deviceConnections: config.deviceConnections || {}
  });
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

const MQTT_FIELDS = ["server", "port", "username", "password", "topic"];

async function readMqttSettings(directory = dataDirectory) {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, "mqtt-connection.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeMqttSettings(settings, directory = dataDirectory) {
  const clean = {};
  for (const field of MQTT_FIELDS) clean[field] = String(settings?.[field] ?? "");
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomically(path.join(directory, "mqtt-connection.json"), clean);
}

function inferConnectionSettings(device) {
  if (!device) return null;
  const controller = device.controller || {};
  const lorawan = device.lorawan || {};
  const chirpstack = lorawan.chirpstack || {};
  return {
    ipAddress: controller.ipAddress || "",
    networkServer: lorawan.networkServer || "tts",
    grpcApiKey: chirpstack.grpcApiKey || "",
    serverAddress: chirpstack.serverAddress || "",
    grpcPort: chirpstack.grpcPort || 8080,
    protocol: controller.protocol || "bacnet",
    model: controller.model || "distechControlsV2",
    bacnetLogin: controller.login || "",
    bacnetPassword: controller.password || ""
  };
}

function applyConnectionsToDevices(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const result = structuredClone(config);
  for (const [deviceName, device] of Object.entries(result.deviceList || {})) {
    const connectionName = result.deviceConnections?.[deviceName] || device.controller?.connectionName || "";
    result.deviceConnections ||= {};
    result.deviceConnections[deviceName] = connectionName;
    const connection = result.connections?.[connectionName];
    device.controller ||= {};
    device.controller.connectionName = connectionName;
    if (!connection) continue;

    device.controller ||= {};
    device.controller.protocol = connection.protocol;
    device.controller.ipAddress = connection.ipAddress;
    if (connection.protocol === "restAPIBacnet") {
      device.controller.model = connection.model;
      device.controller.login = connection.bacnetLogin;
      device.controller.password = connection.bacnetPassword;
    } else {
      delete device.controller.model;
      delete device.controller.login;
      delete device.controller.password;
    }

    device.lorawan ||= {};
    device.lorawan.networkServer = connection.networkServer;
    if (connection.networkServer === "chirpstack") {
      device.lorawan.chirpstack = {
        grpcApiKey: connection.grpcApiKey,
        serverAddress: connection.serverAddress,
        grpcPort: Number(connection.grpcPort) || 8080
      };
    } else {
      delete device.lorawan.chirpstack;
    }
    const hasDownlink = Object.values(device.bacnet?.objects || {}).some((object) => object.dataDirection === "downlink");
    if (connection.networkServer === "actility" && hasDownlink) {
      device.lorawan.actility ||= { driver: { pId: "", mId: "", ver: "" } };
    } else if (connection.networkServer !== "actility" || !hasDownlink) {
      delete device.lorawan.actility;
    }
  }
  return result;
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/mqtt/status", (_request, response) => {
  response.json(mqttService.getStatus());
});

app.get("/api/mqtt/logs", (request, response) => {
  const after = Number.parseInt(request.query.after, 10) || 0;
  response.json({ entries: mqttService.getLogs(after) });
});

app.get("/api/mqtt/raw", (request, response) => {
  const after = Number.parseInt(request.query.after, 10) || 0;
  response.json({ entries: mqttService.getRawMessages(after) });
});

app.get("/api/mqtt/settings", async (_request, response, next) => {
  try {
    response.json(await readMqttSettings());
  } catch (error) {
    next(error);
  }
});

app.put("/api/mqtt/settings", async (request, response, next) => {
  try {
    await writeMqttSettings(request.body);
    response.json({ saved: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mqtt/connect", (request, response) => {
  try {
    response.status(202).json(mqttService.connect(request.body));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/mqtt/disconnect", (_request, response) => {
  response.json(mqttService.disconnect());
});

app.get("/api/config", async (_request, response, next) => {
  try {
    response.json(await readConfig());
  } catch (error) {
    next(error);
  }
});

app.post("/api/config/validate", (request, response) => {
  const errors = validateConfig(applyConnectionsToDevices(request.body));
  response.status(errors.length ? 400 : 200).json({ valid: errors.length === 0, errors });
});

app.put("/api/config", async (request, response, next) => {
  try {
    const config = applyConnectionsToDevices(request.body);
    const errors = validateConfig(config);
    if (errors.length) {
      response.status(400).json({ error: "Configuration is invalid", errors });
      return;
    }

    await writeConfig(config);
    response.json({ saved: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "Request body must contain valid JSON" });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`LoRaBAC is available at http://localhost:${port}`);
  });
}

module.exports = { app, readConfig, writeConfig, inferConnectionSettings, applyConnectionsToDevices };