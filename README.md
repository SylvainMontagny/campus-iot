# LoRaBAC configuration service

An Express application that replaces the LoRaBAC Node-RED editor with a browser-based device-list configuration editor and MQTT uplink listener. It edits global connection settings and Node-RED-compatible device and BACnet object configuration, validates, saves, imports, and exports the JSON, and maps incoming MQTT uplinks into per-device output objects.

## Requirements

- Node.js 20 or newer
- npm

## Run

```powershell
npm install
npm start
```

Open <http://localhost:3000>. Use `npm run dev` during development and `npm test` to run the built-in Node.js test suite. Set `PORT` to change the HTTP port.

The configuration editor persists the device map only in `data/deviceList.json`; the file has device names at its root and contains no `globalConfig` wrapper. Each device stores its selected profile name as `controller.connectionName` alongside its concrete controller and LoRaWAN settings. The editor reconstructs reusable connection profiles from those per-device settings when loading the device list. The local data files are git-ignored because they may contain network credentials. The application reads `deviceList.json` and no longer imports the legacy `data/config.json` format. Export downloads the device-only JSON as `deviceList.json`.

Use the **MQTT connection** section in the navigation rail to enter the broker server, port, login, password, and subscription topic. The server subscribes with MQTT.js; connection credentials are held in server memory and are not written to disk. The header indicator turns green after the broker connection and topic subscription both succeed. Incoming The Things Stack, ChirpStack, and Actility uplinks are mapped using `data/deviceList.json`; the MQTT message log displays legacy-compatible packet errors and each resulting device object.

## HTTP API

- `GET /api/health` returns service status.
- `GET /api/config` returns the device list and reconstructs `connections` and `deviceConnections` from its devices for the editor.
- `POST /api/config/validate` validates a configuration and returns `{ "valid": true, "errors": [] }`.
- `PUT /api/config` validates the device list and persists only `data/deviceList.json`.
- `POST /api/mqtt/connect` starts an MQTT.js broker connection and subscribes to the requested topic.
- `POST /api/mqtt/disconnect` closes the active broker connection.
- `GET /api/mqtt/status` reports the current MQTT connection state.
- `GET /api/mqtt/logs?after=<id>` returns log entries newer than the supplied entry ID.

The `deviceList` uses the same device JSON structure as the Node-RED configuration. Uplink/downlink direction and downlink settings remain available as configuration data; the MQTT listener consumes uplinks and logs mapped device objects but does not publish downlinks.

## Project layout

```text
server.js                 Express API and local config persistence
src/config-validation.js  Configuration rules
src/default-config.js     Initial configuration
public/                   Browser editor
test/                     Node.js built-in tests
```