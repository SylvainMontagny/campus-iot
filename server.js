const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { validateConfig } = require("./src/config-validation");
const { createDefaultConfig } = require("./src/default-config");
const { createMqttService } = require("./src/mqtt-service");
const { createIcalScheduleService } = require("./src/ical-schedule");
const { createDefaultZonesSchedules, createDefaultScheduleEventsConf, validateZonesSchedules, resolveZones, findDuplicateIcalUrls, SCHEDULE_EVENTS } = require("./src/zones-config");
const { testBmsConnection } = require("./src/bms-test");
const { listBmsObjects, deleteBmsObjects } = require("./src/bms-objects");
const { discoverBmsDevices } = require("./src/bms-discovery");
const { buildBmsObjectRows } = require("./src/profile-bms-objects");
const { testIcalUrl } = require("./src/ical-test");
const { scheduleInitialValues } = require("./src/schedule-initial-values");
const { version } = require("./package.json");

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, "data");
const mqttService = createMqttService({
  getDeviceProfiles: async () => (await readConfig()).deviceProfiles,
  // Present value of the schedules controlling the downlink objects, used when those objects are created on the BMS.
  getScheduleValues: async (device) => {
    const config = await readConfig();
    return scheduleInitialValues(device, {
      zonesSchedules: await readZonesSchedules(),
      deviceProfiles: config.deviceProfiles,
      connections: config.connections
    });
  }
});
const scheduleService = createIcalScheduleService({ log: (level, message) => mqttService.log(level, message) });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Configuration storage: loads device profiles and BMS connections, including supported legacy file formats.
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

  for (const [deviceName, device] of Object.entries(config.deviceProfiles)) {
    device.controller ||= {};
    const connectionName = config.deviceConnections[deviceName] || device.controller.connectionName || "";
    config.deviceConnections[deviceName] = connectionName;
    device.controller.connectionName = connectionName;
  }
  return config;
}

// Configuration storage: reads and validates the BMS connection file, with fallback to its legacy name.
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

// Configuration storage: persists device profiles and BMS connection assignments.
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

// Configuration storage: writes JSON to a temporary file before replacing the saved file.
async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

// Zones & Schedules storage: loads saved zones or supplies defaults for a first run.
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

// Zones & Schedules storage: persists global settings, zones, and excluded-zone configuration.
async function writeZonesSchedules(zonesSchedules, directory = dataDirectory) {
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomically(path.join(directory, "zones-schedules.json"), {
    icalToScheduleConf: zonesSchedules.icalToScheduleConf,
    scheduleEventsConf: zonesSchedules.scheduleEventsConf ?? createDefaultScheduleEventsConf(),
    zones: zonesSchedules.zones.map(({ connectionName, ...zone }) => (zone.configuration === SCHEDULE_EVENTS ? { ...zone, connectionName } : zone)),
    excludedZones: zonesSchedules.excludedZones || []
  });
}

// Zones & Schedules startup: passes validated configuration and its BMS context to the schedule service.
function startZonesSchedules(zonesSchedules, config) {
  return scheduleService.start({
    icalToScheduleConf: zonesSchedules.icalToScheduleConf,
    scheduleEventsConf: zonesSchedules.scheduleEventsConf,
    zones: zonesSchedules.zones,
    deviceProfiles: config.deviceProfiles,
    connections: config.connections
  });
}

const MQTT_FIELDS = ["networkServer", "server", "port", "username", "password", "topic", "grpcApiKey", "serverAddress", "grpcPort"];

// MQTT settings storage: loads saved broker settings, falling back to the legacy filename when needed.
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

// MQTT settings storage: persists only the supported broker fields and the auto-connect flag.
async function writeMqttSettings(settings, directory = dataDirectory) {
  const clean = {};
  for (const field of MQTT_FIELDS) clean[field] = String(settings?.[field] ?? "");
  clean.autoConnect = settings?.autoConnect === true;
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomically(path.join(directory, "mqtt-connections.json"), clean);
}

// Configuration migration: derives a BMS connection definition from a device profile's legacy fields.
function inferConnectionSettings(device) {
  if (!device) return null;
  const controller = device.controller || {};
  return {
    ipAddress: controller.ipAddress || "",
    protocol: controller.protocol || "bacnet",
    model: controller.model || "distechControlsV2",
    bacnetLogin: controller.login || "",
    bacnetPassword: controller.password || ""
  };
}

// Configuration normalization: resolves profile-to-BMS assignments and applies connection protocol settings.
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
    // The network server is chosen on the MQTT connection page and already set on each profile.
    device.lorawan.networkServer ||= connection.networkServer || "tts";
    if (device.lorawan.networkServer !== "chirpstack") delete device.lorawan.chirpstack;
    const hasDownlink = Object.values(device.bacnet?.objects || {}).some((object) => object.dataDirection === "downlink");
    if (device.lorawan.networkServer === "actility" && hasDownlink) {
      device.lorawan.actility ||= { driver: { pId: "", mId: "", ver: "" } };
    } else {
      delete device.lorawan.actility;
    }
  }
  return result;
}

// HTTP API: reports application health and the running version.
app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", version });
});

// HTTP API: returns the current MQTT broker connection status.
app.get("/api/mqtt/status", (_request, response) => {
  response.json(mqttService.getStatus());
});

// HTTP API: returns MQTT service logs after an optional sequence number.
app.get("/api/mqtt/logs", (request, response) => {
  const after = Number.parseInt(request.query.after, 10) || 0;
  response.json({ entries: mqttService.getLogs(after) });
});

// HTTP API: returns raw MQTT messages after an optional sequence number.
app.get("/api/mqtt/raw", (request, response) => {
  const after = Number.parseInt(request.query.after, 10) || 0;
  response.json({ entries: mqttService.getRawMessages(after) });
});

// HTTP API: reads saved MQTT broker settings for the settings page.
app.get("/api/mqtt/settings", async (_request, response, next) => {
  try {
    response.json(await readMqttSettings());
  } catch (error) {
    next(error);
  }
});

// HTTP API: saves MQTT broker settings submitted by the settings page.
app.put("/api/mqtt/settings", async (request, response, next) => {
  try {
    await writeMqttSettings(request.body);
    response.json({ saved: true });
  } catch (error) {
    next(error);
  }
});

// HTTP API: connects the MQTT service using the submitted broker settings.
app.post("/api/mqtt/connect", (request, response) => {
  try {
    response.status(202).json(mqttService.connect(request.body));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// HTTP API: disconnects the MQTT service from its broker.
app.post("/api/mqtt/disconnect", (_request, response) => {
  response.json(mqttService.disconnect());
});

// HTTP API: fetches BMS objects and maps them to the selected device profile for the editor.
app.post("/api/device-profiles/:profile/bms-objects", async (request, response) => {
  try {
    const config = await readConfig();
    const definition = config.deviceProfiles[request.params.profile];
    if (!definition) return response.status(404).json({ ok: false, error: "Unknown device profile" });
    const connectionName = config.deviceConnections[request.params.profile];
    const connection = config.connections[connectionName];
    if (!connection) return response.status(400).json({ ok: false, error: "This device profile has no BMS connection" });
    const bmsObjects = await listBmsObjects(connection);
    const rows = buildBmsObjectRows({ deviceProfile: request.params.profile, definition, connectionName, bmsObjects, zonesSchedules: await readZonesSchedules() });
    response.json({ ok: true, rows });
  } catch (error) {
    response.status(502).json({ ok: false, error: error.message });
  }
});

// HTTP API: tests a configured native BACnet or REST BMS connection.
app.post("/api/bms/test", async (request, response) => {
  try {
    const result = await testBmsConnection(request.body);
    response.json(typeof result === "string" ? { ok: true, message: result } : { ok: true, ...result });
  } catch (error) {
    response.status(502).json({ ok: false, error: error.message });
  }
});

// HTTP API: lists the selected controller's supported BACnet objects.
app.post("/api/bms/objects", async (request, response) => {
  try {
    response.json({ ok: true, ...(await listBmsObjects(request.body)) });
  } catch (error) {
    response.status(502).json({ ok: false, error: error.message });
  }
});

// HTTP API: discovers BACnet devices for the BMS connection form.
app.post("/api/bms/who-is", async (_request, response) => {
  try {
    response.json({ ok: true, devices: await discoverBmsDevices() });
  } catch (error) {
    response.status(502).json({ ok: false, error: error.message });
  }
});

// HTTP API: deletes selected BACnet objects from the configured controller.
app.post("/api/bms/objects/delete", async (request, response) => {
  try {
    const { connection, objects } = request.body ?? {};
    response.json({ ok: true, ...(await deleteBmsObjects(connection, objects)) });
  } catch (error) {
    response.status(502).json({ ok: false, error: error.message });
  }
});

// HTTP API: validates and previews an iCalendar URL from the zone editor.
app.post("/api/zones/test-ical", async (request, response) => {
  try {
    response.json({ ok: true, message: await testIcalUrl(request.body?.url) });
  } catch (error) {
    response.status(502).json({ ok: false, error: error.message });
  }
});

// HTTP API: returns device profiles, BMS connections, and Zones & Schedules configuration.
app.get("/api/config", async (_request, response, next) => {
  try {
    response.json({ ...(await readConfig()), zonesSchedules: await readZonesSchedules() });
  } catch (error) {
    next(error);
  }
});

// HTTP API: validates submitted configuration without persisting it.
app.post("/api/config/validate", (request, response) => {
  const config = applyConnectionsToDevices(request.body);
  const errors = validateConfig(config);
  if (!errors.length && request.query.zonesSchedules === "true" && request.body?.zonesSchedules !== undefined) {
    errors.push(...validateZonesSchedules(request.body.zonesSchedules, config));
  }
  response.status(errors.length ? 400 : 200).json({ valid: errors.length === 0, errors });
});

// HTTP API: validates and saves configuration, then applies changed device and schedule settings.
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
      await writeZonesSchedules(zonesSchedules);
      const zones = resolveZones(zonesSchedules, config.deviceProfiles);
      mqttService.log("output", `Zones & Schedules saved.\nzones = ${JSON.stringify(zones, null, 2)}\nicalToScheduleConf = ${JSON.stringify(zonesSchedules.icalToScheduleConf, null, 2)}\nscheduleEventsConf = ${JSON.stringify(zonesSchedules.scheduleEventsConf, null, 2)}`);
      startZonesSchedules(zonesSchedules, config);
    }
    response.json({ saved: true, warnings });
  } catch (error) {
    next(error);
  }
});

// HTTP API error handler: returns client errors for malformed JSON and logs unexpected server failures.
app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "Request body must contain valid JSON" });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

// Application startup: listens for HTTP requests and restores configured MQTT and schedule services.
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
