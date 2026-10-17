const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readConfig, writeConfig, applyConnectionsToDevices } = require("../server");

test("stores only the device profile map in device-profiles.json", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-config-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const config = {
    connections: {
      Office: {
        ipAddress: "10.20.30.40",
        protocol: "restAPIBacnet",
        bacnetLogin: "operator",
        bacnetPassword: "secret",
        networkServer: "tts"
      },
      Unused: {
        ipAddress: "10.20.30.41",
        protocol: "bacnet"
      }
    },
    deviceConnections: { sensor: "Office" },
    deviceProfiles: {
      sensor: {
        identity: { maxDevNum: 4 },
        controller: {
          ipAddress: "192.168.1.10",
          protocol: "restAPIBacnet",
          login: "operator",
          password: "secret"
        },
        lorawan: { networkServer: "tts" },
        bacnet: { objects: {} }
      }
    }
  };

  await writeConfig(config, directory);
  const fileContent = await fs.readFile(path.join(directory, "device-profiles.json"), "utf8");
  assert.deepEqual(JSON.parse(fileContent), config.deviceProfiles);
  assert.equal(fileContent.includes("globalConfig"), false);

  const materialized = applyConnectionsToDevices(config);
  assert.equal(materialized.deviceProfiles.sensor.controller.ipAddress, "10.20.30.40");
  assert.equal(materialized.deviceProfiles.sensor.controller.login, "operator");
  assert.equal(materialized.deviceProfiles.sensor.controller.connectionName, "Office");
  assert.equal(config.deviceProfiles.sensor.controller.ipAddress, "192.168.1.10");
  await writeConfig(materialized, directory);
  const savedDeviceProfiles = JSON.parse(await fs.readFile(path.join(directory, "device-profiles.json"), "utf8"));
  assert.equal(savedDeviceProfiles.sensor.controller.ipAddress, "10.20.30.40");
  const savedConnections = JSON.parse(await fs.readFile(path.join(directory, "bms-connections.json"), "utf8"));
  assert.equal(savedConnections["bms-connections"].Office.ipAddress, "10.20.30.40");

  const restored = await readConfig(directory);
  assert.deepEqual(restored.deviceProfiles, savedDeviceProfiles);
  assert.equal(restored.deviceProfiles.sensor.controller.connectionName, "Office");
  assert.equal(restored.connections.Office.ipAddress, "10.20.30.40");
  assert.equal(restored.connections.Office.bacnetLogin, "operator");
  assert.equal(restored.connections.Unused.ipAddress, "10.20.30.41");
  assert.deepEqual(restored.deviceConnections, config.deviceConnections);
});

test("uses controller.connectionName as the profile assignment fallback", () => {
  const config = {
    connections: {
      Office: {
        ipAddress: "192.168.1.10",
        protocol: "bacnet",
        networkServer: "tts"
      }
    },
    deviceProfiles: {
      sensor: {
        controller: { connectionName: "Office" },
        lorawan: {},
        bacnet: { objects: {} }
      }
    }
  };

  const result = applyConnectionsToDevices(config);
  assert.equal(result.deviceConnections.sensor, "Office");
  assert.equal(result.deviceProfiles.sensor.controller.connectionName, "Office");
  assert.equal(result.deviceProfiles.sensor.controller.ipAddress, "192.168.1.10");
});

test("ignores legacy config.json when device-profiles.json is missing", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-legacy-config-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({
    globalConfig: { ipAddress: "10.0.0.1" },
    deviceProfiles: { legacyDevice: {} }
  }));

  const config = await readConfig(directory);
  assert.deepEqual(config, require("../src/default-config").createDefaultConfig());
});

test("reads legacy deviceList.json and upgrades identity.deviceType", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-device-list-migration-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "deviceList.json"), JSON.stringify({
    sensor: {
      identity: { maxDevNum: 4, deviceType: "sensor" },
      controller: { ipAddress: "192.168.1.10", protocol: "bacnet" },
      lorawan: { networkServer: "tts" },
      bacnet: { objects: {} }
    }
  }));

  const config = await readConfig(directory);
  assert.equal(config.deviceProfiles.sensor.identity.deviceProfile, "sensor");
  assert.equal(Object.hasOwn(config.deviceProfiles.sensor.identity, "deviceType"), false);
  assert.equal(Object.hasOwn(config, "deviceList"), false);
});

test("reads legacy deviceProfiles.json and saves using device-profiles.json", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-device-profiles-migration-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacyProfiles = {
    sensor: {
      identity: { maxDevNum: 4 },
      controller: { ipAddress: "192.168.1.10", protocol: "bacnet" },
      lorawan: { networkServer: "tts" },
      bacnet: { objects: {} }
    }
  };
  await fs.writeFile(path.join(directory, "deviceProfiles.json"), JSON.stringify(legacyProfiles));

  const config = await readConfig(directory);
  assert.equal(config.deviceProfiles.sensor.identity.maxDevNum, 4);
  const normalizedProfiles = structuredClone(config.deviceProfiles);
  await writeConfig(config, directory);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "device-profiles.json"), "utf8")), normalizedProfiles);
});

test("normalizes legacy deviceList and identity.deviceType API fields", () => {
  const config = {
    deviceList: {
      sensor: { identity: { deviceType: "sensor" }, controller: {}, lorawan: {}, bacnet: { objects: {} } }
    }
  };

  const normalized = applyConnectionsToDevices(config);
  assert.equal(normalized.deviceProfiles.sensor.identity.deviceProfile, "sensor");
  assert.equal(Object.hasOwn(normalized, "deviceList"), false);
  assert.equal(Object.hasOwn(normalized.deviceProfiles.sensor.identity, "deviceType"), false);
  assert.equal(Object.hasOwn(config, "deviceList"), true);
});

test("device profiles never create BMS connections", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-no-connection-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const deviceProfiles = {
    office: {
      identity: { maxDevNum: 2 },
      controller: { connectionName: "Office LAN", ipAddress: "192.168.1.10", protocol: "bacnet" },
      lorawan: { networkServer: "tts" },
      bacnet: { objects: {} }
    },
    lab: { controller: { ipAddress: "10.0.0.15" }, lorawan: { networkServer: "tts" } }
  };
  await fs.writeFile(path.join(directory, "device-profiles.json"), JSON.stringify(deviceProfiles));
  await fs.writeFile(path.join(directory, "bms-connections.json"), JSON.stringify({ connections: { "Lab LAN": { ipAddress: "10.0.0.15", protocol: "bacnet" } }, deviceConnections: { lab: "Lab LAN" } }));

  const restored = await readConfig(directory);
  assert.deepEqual(Object.keys(restored.connections), ["Lab LAN"]);
  assert.equal(restored.deviceConnections.office, "Office LAN");
  assert.equal(restored.deviceConnections.lab, "Lab LAN");
});
