const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { validateConfig } = require("./src/config-validation");
const { createDefaultConfig } = require("./src/default-config");
const { createMqttService } = require("./src/mqtt-service");
const { createIcalScheduleService } = require("./src/ical-schedule");
const { createDefaultZonesSchedules, createDefaultScheduleEventsConf, validateZonesSchedules, resolveZones, findDuplicateIcalUrls } = require("./src/zones-config");
const { testBmsConnection } = require("./src/bms-test");
const { testIcalUrl } = require("./src/ical-test");
const { version } = require("./package.json");

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, "data");
const mqttService = createMqttService({
  getDeviceProfiles: async () => (await readConfig()).deviceProfiles
});
const scheduleService = createIcalScheduleService({ log: (level, message) => mqttService.log(level, message) });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function readConfig(directory = dataDirectory) {
  const deviceProfilesPath = path.join(directory, "device-profiles.json");
  let savedData;
  try {
    savedData = JSON.parse(await fs.readFile(deviceProfilesPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      savedData = JSON.parse(await fs.readFile(path.join(directory, "deviceProfiles.json"), "utf8"));
    } catch (legacyError) {
      if (legacyError.code !== "ENOENT") throw legacyError;
      try {
        savedData = JSON.parse(await fs.readFile(path.join(directory, "deviceList.json"), "utf8"));
      } catch (deviceListError) {
        if (deviceListError.code === "ENOENT") return createDefaultConfig();
        throw deviceListError;
      }
    }
  }

  const savedBmsConnections = await readBmsConnections(directory);
  const config = {
    ...createDefaultConfig(),
    ...savedData,
    deviceProfiles: savedData.deviceProfiles || savedData.deviceList || savedData
  };
  delete config.deviceList;
  for (const device of Object.values(config.deviceProfiles)) {
    if (device.identity?.deviceProfile === undefined && device.identity?.deviceType !== undefined) {
      device.identity.deviceProfile = device.identity.deviceType;
    }
    if (device.identity) delete device.identity.deviceType;
  }
  config.connections = {
    ...savedBmsConnections.connections,
    ...(config.connections || {})
  };
  config.deviceConnections = {
    ...savedBmsConnections.deviceConnections,
    ...(config.deviceConnections || {})
  };

  const namedConnections = new Map();
  for (const [deviceName, device] of Object.entries(config.deviceProfiles)) {
    const profileName = (device.controller?.connectionName || config.deviceConnections[deviceName] || "").trim();
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
    config.connections = { ...config.connections, ...Object.fromEntries(namedConnections) };
    for (const deviceName of Object.keys(config.deviceProfiles)) config.deviceConnections[deviceName] ||= "";
  } else {
    const settingsToName = new Map();
    config.deviceConnections = {};
    for (const [deviceName, device] of Object.entries(config.deviceProfiles)) {
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
  for (const [deviceName, device] of Object.entries(config.deviceProfiles)) {
    device.controller ||= {};
    const connectionName = config.deviceConnections[deviceName] || device.controller.connectionName || "";
    config.deviceConnections[deviceName] = connectionName;
    device.controller.connectionName = connectionName;
  }
  return config;
}

async function readBmsConnections(directory = dataDirectory) {
  let savedData;
  try {
    savedData = JSON.parse(await fs.readFile(path.join(directory, "bms-connections.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      savedData = JSON.parse(await fs.readFile(path.join(directory, "connections.json"), "utf8"));
    } catch (legacyError) {
      if (legacyError.code === "ENOENT") return { connections: {}, deviceConnections: {} };
      throw legacyError;
    }
  }

  const connections = savedData?.["bms-connections"] || savedData?.connections;
  if (!connections || typeof connections !== "object" || Array.isArray(connections)) {
    throw new Error("BMS connections file must contain a 'bms-connections' object");
  }
  const deviceConnections = savedData.deviceConnections || {};
  if (typeof deviceConnections !== "object" || Array.isArray(deviceConnections)) {
    throw new Error("BMS connections file must contain a deviceConnections object");
  }
  return { connections, deviceConnections };
}

async function writeConfig(config, directory = dataDirectory) {
  const deviceProfilesPath = path.join(directory, "device-profiles.json");
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomically(deviceProfilesPath, config.deviceProfiles);
  // Assigned profiles are rebuilt from device settings; this file also retains unused profiles.
  await writeJsonAtomically(path.join(directory, "bms-connections.json"), {
    "bms-connections": config.connections || {},
    deviceConnections: config.deviceConnections || {}
  });
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function readZonesSchedules(directory = dataDirectory) {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(directory, "zones-schedules.json"), "utf8"));
    // Files saved before the second global configuration existed get its defaults.
    return { ...stored, scheduleEventsConf: stored.scheduleEventsConf ?? createDefaultScheduleEventsConf() };
  } catch (error) {
    if (error.code === "ENOENT") return createDefaultZonesSchedules();
    throw error;
  }
}

async function writeZonesSchedules(zonesSchedules, directory = dataDirectory) {
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomically(path.join(directory, "zones-schedules.json"), {
    icalToScheduleConf: zonesSchedules.icalToScheduleConf,
    scheduleEventsConf: zonesSchedules.scheduleEventsConf ?? createDefaultScheduleEventsConf(),
    zones: zonesSchedules.zones,
    excludedZones: zonesSchedules.excludedZones || []
  });
}

function startZonesSchedules(zonesSchedules, config) {
  return scheduleService.start({
    icalToScheduleConf: zonesSchedules.icalToScheduleConf,
    scheduleEventsConf: zonesSchedules.scheduleEventsConf,
    zones: zonesSchedules.zones,
    deviceProfiles: config.deviceProfiles,
    connections: config.connections
  });
}

const MQTT_FIELDS = ["server", "port", "username", "password", "topic"];

async function readMqttSettings(directory = dataDirectory) {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, "mqtt-connections.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      return JSON.parse(await fs.readFile(path.join(directory, "mqtt-connection.json"), "utf8"));
    } catch (legacyError) {
      if (legacyError.code === "ENOENT") return {};
      throw legacyError;
    }
  }
}

async function writeMqttSettings(settings, directory = dataDirectory) {
  const clean = {};
  for (const field of MQTT_FIELDS) clean[field] = String(settings?.[field] ?? "");
  clean.autoConnect = settings?.autoConnect === true;
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomically(path.join(directory, "mqtt-connections.json"), clean);
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
  if (result.deviceProfiles === undefined && result.deviceList !== undefined) {
    result.deviceProfiles = result.deviceList;
  }
  delete result.deviceList;
  for (const [deviceName, device] of Object.entries(result.deviceProfiles || {})) {
    if (device.identity?.deviceProfile === undefined && device.identity?.deviceType !== undefined) {
      device.identity.deviceProfile = device.identity.deviceType;
    }
    if (device.identity) delete device.identity.deviceType;
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
  response.json({ status: "ok", version });
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

app.post("/api/bms/test", async (request, response) => {
  try {
    response.json({ ok: true, message: await testBmsConnection(request.body) });
  } catch (error) {
    response.status(502).json({ ok: false, error: error.message });
  }
});

app.post("/api/zones/test-ical", async (request, response) => {
  try {
    response.json({ ok: true, message: await testIcalUrl(request.body?.url) });
  } catch (error) {
    response.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/config", async (_request, response, next) => {
  try {
    response.json({ ...(await readConfig()), zonesSchedules: await readZonesSchedules() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/config/validate", (request, response) => {
  const config = applyConnectionsToDevices(request.body);
  const errors = validateConfig(config);
  if (!errors.length && request.query.zonesSchedules === "true" && request.body?.zonesSchedules !== undefined) {
    errors.push(...validateZonesSchedules(request.body.zonesSchedules, config));
  }
  response.status(errors.length ? 400 : 200).json({ valid: errors.length === 0, errors });
});

app.put("/api/config", async (request, response, next) => {
  try {
    const config = applyConnectionsToDevices(request.body);
    const zonesSchedules = request.body?.zonesSchedules;
    const errors = validateConfig(config);
    if (!errors.length && zonesSchedules !== undefined) errors.push(...validateZonesSchedules(zonesSchedules, config));
    if (errors.length) {
      response.status(400).json({ error: "Configuration is invalid", errors });
      return;
    }

    const previousDeviceProfiles = (await readConfig()).deviceProfiles;
    await writeConfig(config);
    // previousValues is keyed by device name, so every device of a changed type is cleared.
    for (const deviceProfile of new Set([...Object.keys(previousDeviceProfiles), ...Object.keys(config.deviceProfiles)])) {
      if (!isDeepStrictEqual(previousDeviceProfiles[deviceProfile], config.deviceProfiles[deviceProfile])) {
        mqttService.clearPreviousValues(deviceProfile);
      }
    }
    const warnings = zonesSchedules === undefined ? [] : findDuplicateIcalUrls(zonesSchedules.zones);
    if (zonesSchedules !== undefined) {
      await writeZonesSchedules(zonesSchedules);(zonesSchedules);
      const zones = resolveZones(zonesSchedules);
      mqttService.log("output", `Zones & Schedules saved.\nzones = ${JSON.stringify(zones, null, 2)}\nicalToScheduleConf = ${JSON.stringify(zonesSchedules.icalToScheduleConf, null, 2)}\nscheduleEventsConf = ${JSON.stringify(zonesSchedules.scheduleEventsConf, null, 2)}`);
      startZonesSchedules(zonesSchedules, config);
    }
    response.json({ saved: true, warnings });
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
  app.listen(port, async () => {
    console.log(`Campus IoT is available at http://localhost:${port}`);
    try {
      const settings = await readMqttSettings();
      if (settings.autoConnect === true) mqttService.connect(settings);
    } catch (error) {
      console.error(`MQTT auto-connect failed: ${error.message}`);
    }
    try {
      await startZonesSchedules(await readZonesSchedules(), await readConfig());
    } catch (error) {
      console.error(`Zones & Schedules start failed: ${error.message}`);
    }
  });
}

module.exports = { app, readConfig, writeConfig, inferConnectionSettings, applyConnectionsToDevices };