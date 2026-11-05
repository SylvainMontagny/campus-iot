const fs = require("node:fs/promises");
const path = require("node:path");
const { createDefaultConfig } = require("./defaults");
const { createDefaultZonesSchedules, createDefaultScheduleEventsConf, SCHEDULE_EVENTS } = require("../zones-schedules/configuration");

const dataDirectory = path.join(__dirname, "..", "..", "data");
const MQTT_FIELDS = ["networkServer", "server", "port", "username", "password", "topic", "grpcApiKey", "serverAddress", "grpcPort"];

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

module.exports = {
  readConfig,
  readBmsConnections,
  writeConfig,
  readZonesSchedules,
  writeZonesSchedules,
  readMqttSettings,
  writeMqttSettings,
  inferConnectionSettings,
  applyConnectionsToDevices
};
