# LoRaBAC configuration service

An Express application that replaces the LoRaBAC Node-RED editor with a browser-based device-profile configuration editor and MQTT uplink listener. It edits global connection settings and Node-RED-compatible device and BACnet object configuration, validates, saves, imports, and exports the JSON, and maps incoming MQTT uplinks into per-device output objects.

## Requirements

- Node.js 20 or newer
- npm

## Run

```powershell
npm install
npm start
```

Open <http://localhost:3000>. Use `npm run dev` during development and `npm test` to run the built-in Node.js test suite. Set `PORT` to change the HTTP port.

The configuration editor persists device profiles in `data/device-profiles.json`; profile names are the keys at the file root and there is no `globalConfig` wrapper. Each device profile stores its selected BMS connection name as `controller.connectionName` alongside its controller and LoRaWAN settings. Assigned BMS connections are reconstructed from profile settings, while unassigned connections are retained in `data/bms-connections.json`. MQTT settings and zone schedules are stored in `data/mqtt-connections.json` and `data/zones-schedules.json`. Local data files are git-ignored because they may contain network credentials. On startup, the application also reads legacy `data/deviceProfiles.json` and `data/deviceList.json` files; subsequent saves use `device-profiles.json`. It migrates `identity.deviceType` to `identity.deviceProfile` and does not import the older `data/config.json` format. Export downloads all four JSON files. Import accepts one or more of these files in a single selection; select all four to restore a complete configuration, then use **Save configuration** to persist it.

Use the **MQTT connection** section in the navigation rail to choose the **LoRaWAN Network server** (first field) and enter the broker server, port, login, password, and subscription topic. Choosing a network server prefills empty (or still-prefilled) fields: port 1883 always; for **The Things Stack (TTN)** server `eu1.cloud.thethings.network`, login `YOUR_APPLICATION_ID@ttn` and topic `v3/YOUR_APPLICATION_ID@ttn/devices/+/up`; for **The Things Stack (TTS)** the same without `@ttn`; for **ChirpStack** topic `application/YOUR_APPLICATION_ID/device/+/event/up` (plus its gRPC fields). The selected network server is stored in `data/mqtt-connections.json` and written to `lorawan.networkServer` of every device profile on save; TTN is processed exactly like TTS. Existing installations take the value from their device profiles until it is saved with the MQTT connection. The server subscribes with MQTT.js; the header indicator turns green after the broker connection and topic subscription both succeed. Incoming The Things Stack, ChirpStack, and Actility uplinks are mapped using `data/device-profiles.json`; the MQTT message log displays legacy-compatible packet errors and each resulting device object.

**Zones & Schedules** has two global configurations, stored in `data/zones-schedules.json` as `icalToScheduleConf` and `scheduleEventsConf`. Each zone chooses one with its `configuration` field (default `icalToScheduleConf`):

- **Manage LoRaWAN devices from ical calendar** (`icalToScheduleConf`): the application creates the BACnet schedules and scheduleAV objects of the zones, binds the scheduleAV values to the LoRaWAN devices, then keeps the schedules fed from the iCal calendars.
- **Add event to BACnet schedule object** (`scheduleEventsConf`): the zone gives the `scheduleID` of an existing BACnet schedule object; the application only updates its events from the iCal calendar (no schedule, scheduleAV, binding or instance-range handling). Zones saved before this option existed use the first configuration.

Every BMS action of Zones & Schedules follows the **BMS protocol** of the zone's BMS connection. With **REST API BACnet** the Distech REST API is used. With **BACnet** the schedules are managed natively with bacnet-js (`src/bacnet-schedule.js`): schedule and scheduleAV objects are created and deleted with the BACnet object services, events are written to `EXCEPTION_SCHEDULE`, `WEEKLY_SCHEDULE` and `SCHEDULE_DEFAULT`, and, as BACnet has no binding service, the scheduleAV value is written directly (priority 14) to the bound device objects.

For LoRaWAN device processing, both **REST API BACnet** and native **BACnet** create configured objects reported as missing by the controller, then initialize them with the current uplink values and the configured (or previously saved) downlink values. Native BACnet recognizes the standard unknown-object error by its BACnet error class/code as well as controller error text. It sends one create request at a time, waits for the controller response before continuing, and does not retry a rejected or timed-out create request.

## HTTP API

- `GET /api/health` returns service status.
- `GET /api/config` returns the device profiles and reconstructs `connections` and `deviceConnections` from its devices for the editor.
- `POST /api/config/validate` validates a configuration and returns `{ "valid": true, "errors": [] }`.
- `PUT /api/config` validates the device profiles and persists only `data/device-profiles.json`.
- `POST /api/zones/test-ical` fetches the supplied zone URL and verifies that it contains a valid iCalendar feed.
- `POST /api/mqtt/connect` starts an MQTT.js broker connection and subscribes to the requested topic.
- `POST /api/mqtt/disconnect` closes the active broker connection.
- `GET /api/mqtt/status` reports the current MQTT connection state.
- `GET /api/mqtt/logs?after=<id>` returns log entries newer than the supplied entry ID.

The `deviceProfiles` map uses the same device JSON structure as the Node-RED configuration. Uplink/downlink direction and downlink settings remain available as configuration data; the MQTT listener consumes uplinks and logs mapped device objects but does not publish downlinks.

## Project layout

```text
server.js                 Express API and local config persistence
src/config-validation.js  Configuration rules
src/default-config.js     Initial configuration
public/                   Browser editor
test/                     Node.js built-in tests
```