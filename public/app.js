const state = {
  config: null,
  selectedDevice: null,
  selectedConnection: null,
  selectedZone: null,
  selectedView: "mqtt",
  expandedDevices: {},
  expandedObjects: {},
  expandedAdvanced: {},
  expandedZoneDevices: {},
  noticeTimer: null,
  mqttLogId: 0,
  mqttRawId: 0,
  paused: { log: false, raw: false }
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

const ICAL_CONF = "icalToScheduleConf";
const EVENTS_CONF = "scheduleEventsConf";
const SCHEDULE_CONFIGS = [
  [ICAL_CONF, "Manage LoRaWAN devices from ical calendar"],
  [EVENTS_CONF, "Add events to an existing BACnet schedule object"]
];

function defaultScheduleDefaults() {
  return {
    groupEvents: true, timeZone: "Europe/Paris", eventsToDiscard: ["SOBRIETE ENERGETIQUE"],
    minimumSlotDuration: 0, valueOccupied: 19, valueUnOccupied: 15,
    timeOffsetBeforeStart: 60, timeOffsetBeforeEnd: 60, nbrDaysPreview: 10, addSuffixToAdeURL: false,
    weekly: {}
  };
}

function defaultZonesSchedules() {
  return {
    icalToScheduleConf: {
      timeBetweenScheduleUpdate: 180,
      timeBetweenScheduleAVUpdate: 30,
      scheduleInstanceRange: [0, 50],
      scheduleAVInstanceOffset: 10000,
      logs: { eventsAddedInSchedules: true, eventTimeCreation: true, scheduleAVUpdate: true },
      defaults: defaultScheduleDefaults()
    },
    scheduleEventsConf: {
      timeBetweenScheduleUpdate: 180,
      logs: { eventsAddedInSchedules: true, eventTimeCreation: true },
      defaults: defaultScheduleDefaults()
    },
    zones: []
  };
}

// Fills what files saved before the second global configuration (or the log options) do not contain.
function normalizeZonesSchedules(zonesSchedules) {
  const defaults = defaultZonesSchedules();
  for (const [key] of SCHEDULE_CONFIGS) {
    zonesSchedules[key] = { ...defaults[key], ...zonesSchedules[key] };
    zonesSchedules[key].logs = { ...defaults[key].logs, ...zonesSchedules[key].logs };
  }
  return zonesSchedules;
}

const confKeyOfZone = (zone) => (zone?.configuration === EVENTS_CONF ? EVENTS_CONF : ICAL_CONF);

function defaultConfig() {
  return {
    deviceProfiles: {},
    connections: {},
    deviceConnections: {},
    zonesSchedules: defaultZonesSchedules()
  };
}

function defaultConnection() {
  return {
    ipAddress: "",
    protocol: "bacnet", model: "distechControlsV2", bacnetLogin: "", bacnetPassword: ""
  };
}

// The LoRaWAN network server is chosen on the MQTT connection page and applies to every device profile.
const NETWORK_PREFILLS = {
  ttn: { server: "eu1.cloud.thethings.network", username: "YOUR_APPLICATION_ID@ttn", topic: "v3/YOUR_APPLICATION_ID@ttn/devices/+/up" },
  tts: { server: "eu1.cloud.thethings.network", username: "YOUR_APPLICATION_ID", topic: "v3/YOUR_APPLICATION_ID/devices/+/up" },
  chirpstack: { topic: "application/YOUR_APPLICATION_ID/device/+/event/up" },
  actility: {}
};
const MQTT_TEXT_FIELDS = ["networkServer", "server", "port", "username", "password", "topic", "grpcApiKey", "serverAddress", "grpcPort"];

function networkSettings() {
  return {
    networkServer: $("#mqtt-networkServer").value,
    grpcApiKey: $("#mqtt-grpcApiKey").value,
    serverAddress: $("#mqtt-serverAddress").value,
    grpcPort: $("#mqtt-grpcPort").value
  };
}

// Fields still holding a prefilled value of any network server are replaced; values typed by the user are kept.
function applyNetworkPrefill(onlyEmpty = false) {
  const prefill = NETWORK_PREFILLS[$("#mqtt-networkServer").value] || {};
  for (const field of ["server", "username", "topic"]) {
    const input = $(`#mqtt-${field}`);
    const isPrefilled = Object.values(NETWORK_PREFILLS).some((values) => values[field] === input.value);
    if (!input.value || (!onlyEmpty && isPrefilled)) input.value = prefill[field] ?? "";
  }
  if (!$("#mqtt-port").value) $("#mqtt-port").value = "1883";
}

function toggleChirpstackFields() {
  $("#mqtt-chirpstack-fields").hidden = $("#mqtt-networkServer").value !== "chirpstack";
}

function networkFromProfiles(profiles) {
  const lorawan = Object.values(profiles || {}).map((device) => device.lorawan).find((item) => item?.networkServer);
  if (!lorawan) return null;
  const chirpstack = lorawan.chirpstack || {};
  return { networkServer: lorawan.networkServer, grpcApiKey: chirpstack.grpcApiKey || "", serverAddress: chirpstack.serverAddress || "", grpcPort: chirpstack.grpcPort || 8080 };
}

function showNetworkSettings(network) {
  $("#mqtt-networkServer").value = network.networkServer;
  $("#mqtt-grpcApiKey").value = network.grpcApiKey ?? "";
  $("#mqtt-serverAddress").value = network.serverAddress ?? "";
  $("#mqtt-grpcPort").value = network.grpcPort || 8080;
  toggleChirpstackFields();
}

function inferNetworkFromProfiles(profiles = state.config.deviceProfiles) {
  const network = networkFromProfiles(profiles);
  if (network) showNetworkSettings(network);
}

// Existing profiles define the network server until one has been saved with the MQTT connection.
function inferNetworkWhenUnsaved() {
  if (state.mqttLoaded && state.configLoaded && !state.mqttNetworkSaved) {
    inferNetworkFromProfiles();
    applyNetworkPrefill(true);
  }
}

function makeDevice(name, connectionName) {
  const device = {
    identity: { maxDevNum: 10 },
    controller: { debug: ["all"], connectionName: connectionName || "" },
    lorawan: { flushDownlinkQueue: false, class: "A" },
    bacnet: { offsetAV: 0, offsetBV: 0, instanceRangeAV: 10, instanceRangeBV: 10, objects: {} },
    mqtt: { topicDownlink: {} }
  };
  state.config.deviceConnections[name] = connectionName || "";
  if (connectionName) applyConnection(device, state.config.connections[connectionName], connectionName);
  return device;
}

function makeObject() {
  return {
    lorawanPayloadName: "payload-name", dataDirection: "uplink", downlinkPort: 30,
    assignementMode: "auto", downlinkStrategy: "compareToUplinkObject", instanceNum: 0,
    downlinkPortPriority: "low", objectType: "analogValue", uplinkToCompareWith: "",
    range: [0, 100], value: 0
  };
}

// Smallest instance offset not yet used by another auto object of the same type.
function nextInstanceOffset(device, objectType, excludeName) {
  const used = new Set(Object.entries(device.bacnet.objects)
    .filter(([name, o]) => name !== excludeName && o.objectType === objectType && o.assignementMode !== "manual")
    .map(([, o]) => Number(o.instanceNum)));
  let candidate = 0;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

function setPath(object, path, value) {
  const keys = path.split(".");
  const finalKey = keys.pop();
  const parent = keys.reduce((current, key) => current[key], object);
  parent[finalKey] = value;
}

function inputField(label, path, value, options = {}) {
  const { type = "text", wide = false, min, max, step, secret = false, placeholder = "" } = options;
  const attrs = [min !== undefined ? `min="${min}"` : "", max !== undefined ? `max="${max}"` : "", step !== undefined ? `step="${step}"` : ""].filter(Boolean).join(" ");
  return `<label class="field${wide ? " field-wide" : ""}"><span>${escapeHtml(label)}</span><input data-path="${escapeHtml(path)}" type="${secret ? "password" : type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${attrs} autocomplete="off"></label>`;
}

function selectField(label, path, value, options, wide = false) {
  const choices = options.map(([optionValue, text]) => `<option value="${escapeHtml(optionValue)}"${String(value) === String(optionValue) ? " selected" : ""}>${escapeHtml(text)}</option>`).join("");
  return `<label class="field${wide ? " field-wide" : ""}"><span>${escapeHtml(label)}</span><select data-path="${escapeHtml(path)}">${choices}</select></label>`;
}

function checkbox(label, checked, key) {
  return `<label class="check-field"><input type="checkbox" data-debug="${key}"${checked ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`;
}

function applyConnection(device, connection, connectionName = "", network = networkSettings()) {
  device.controller ||= {};
  device.controller.connectionName = connectionName;
  if (!connection) return;
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
  device.lorawan.networkServer = network.networkServer;
  if (network.networkServer === "chirpstack") {
    device.lorawan.chirpstack = {
      grpcApiKey: network.grpcApiKey,
      serverAddress: network.serverAddress,
      grpcPort: Number(network.grpcPort) || 8080
    };
  } else {
    delete device.lorawan.chirpstack;
  }
  if (network.networkServer === "actility" && hasDownlink(device)) {
    device.lorawan.actility ||= { driver: { pId: "", mId: "", ver: "" } };
  } else {
    delete device.lorawan.actility;
  }
}

function applyConnectionToAssignedDevices(connectionName) {
  for (const [deviceName, device] of Object.entries(state.config.deviceProfiles)) {
    if (state.config.deviceConnections[deviceName] === connectionName) {
      applyConnection(device, state.config.connections[connectionName], connectionName);
    }
  }
}

function connectionFromDevice(device) {
  const controller = device.controller || {};
  return {
    ipAddress: controller.ipAddress || "",
    protocol: controller.protocol || "bacnet",
    model: controller.model || "distechControlsV2",
    bacnetLogin: controller.login || "",
    bacnetPassword: controller.password || ""
  };
}

function rebuildConnectionsFromDeviceProfiles(deviceProfiles) {
  const connections = {};
  const deviceConnections = {};
  let unnamedIndex = 1;

  for (const [deviceName, device] of Object.entries(deviceProfiles)) {
    let connectionName = device.controller?.connectionName?.trim();
    if (!connectionName) {
      while (Object.hasOwn(connections, `Connection ${unnamedIndex}`)) unnamedIndex += 1;
      connectionName = `Connection ${unnamedIndex++}`;
    }
    const settings = connectionFromDevice(device);
    if (connections[connectionName] && JSON.stringify(connections[connectionName]) !== JSON.stringify(settings)) {
      throw new Error(`Devices assigned to connection '${connectionName}' have conflicting settings.`);
    }
    connections[connectionName] = settings;
    deviceConnections[deviceName] = connectionName;
    device.controller ||= {};
    device.controller.connectionName = connectionName;
  }

  return { connections, deviceConnections };
}

function hasDownlink(device) {
  return Object.values(device.bacnet?.objects || {}).some((object) => object.dataDirection === "downlink");
}

function renderGlobal() {
  const connectionName = state.selectedConnection;
  const global = state.config.connections[connectionName];
  const removeButton = $("[data-action='delete-connection']");
  const nameInput = $("#connection-name");
  if (!global) {
    nameInput.value = "";
    nameInput.disabled = true;
    removeButton.disabled = true;
    $("#global-form").innerHTML = `<div class="connection-empty"><h3>No connection profiles</h3><p>Create a named connection profile, then select it from a device profile.</p><button class="button button-primary" type="button" data-action="add-connection">Add connection</button></div>`;
    return;
  }

  nameInput.disabled = false;
  nameInput.value = connectionName;
  removeButton.disabled = false;
  const fields = [
    `<div class="field-row">${inputField("BMS IP address", "ipAddress", global.ipAddress, { placeholder: "192.168.1.10" })}</div>`,
    `<div class="field-pair">${selectField("BMS protocol", "protocol", global.protocol, [["bacnet", "BACnet"], ["restAPIBacnet", "REST API BACnet"]])}${global.protocol === "restAPIBacnet" ? selectField("REST API model", "model", global.model, [["distechControlsV2", "Distech Controls v2"]]) : ""}</div>`
  ];
  if (global.protocol === "restAPIBacnet") {
    fields.push(`<div class="field-pair">${inputField("Login", "bacnetLogin", global.bacnetLogin)}${inputField("Password", "bacnetPassword", global.bacnetPassword, { secret: true })}</div>`);
  }
  fields.push(`<div class="mqtt-actions"><button class="button button-primary" type="button" data-action="test-connection">Test</button></div>`);
  $("#global-form").innerHTML = fields.map((html) => html.replaceAll("data-path=", "data-connection-field=")).join("");
  renderBmsObjects(connectionName);
}

const objectKey = (object) => `${object.type}:${object.instance}`;

function sortedObjects(objects, sort) {
  if (!sort) return objects;
  const factor = sort.dir === "desc" ? -1 : 1;
  return [...objects].sort((a, b) => {
    const left = a[sort.key] ?? "";
    const right = b[sort.key] ?? "";
    const numeric = left !== "" && right !== "" && !Number.isNaN(Number(left)) && !Number.isNaN(Number(right));
    return factor * (numeric ? Number(left) - Number(right) : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" }));
  });
}

function table(group, columns, objects, result) {
  const sort = result.sort?.[group];
  const selected = result.selected;
  const rows = sortedObjects(objects, sort);
  const allChecked = rows.length > 0 && rows.every((object) => selected.has(objectKey(object)));
  const someChecked = !allChecked && rows.some((object) => selected.has(objectKey(object)));
  const head = columns.map(([key, label]) => {
    const arrow = sort?.key === key ? (sort.dir === "desc" ? "▼" : "▲") : "↕";
    return `<th><button class="bms-sort${sort?.key === key ? " is-active" : ""}" type="button" data-action="sort-bms-objects" data-group="${group}" data-key="${key}" title="Sort by ${label.toLowerCase()}">${label}<span aria-hidden="true">${arrow}</span></button></th>`;
  }).join("");
  const body = rows.map((object) => `<tr><td class="bms-check"><input type="checkbox" data-bms-select="${escapeHtml(objectKey(object))}" aria-label="Select ${escapeHtml(object.name || objectKey(object))}"${selected.has(objectKey(object)) ? " checked" : ""}></td>${columns.map(([key]) => `<td>${escapeHtml(String(object[key] ?? ""))}</td>`).join("")}</tr>`).join("");
  return `<div class="bms-objects-table-wrap"><table class="bms-objects-table"><thead><tr><th class="bms-check"><input type="checkbox" data-bms-select-all="${group}" aria-label="Select all or none"${allChecked ? " checked" : ""}${someChecked ? " data-indeterminate" : ""}></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderBmsObjects(connectionName) {
  const result = state.bmsObjects?.[connectionName];
  let body = "";
  if (result?.loading) body = `<p class="bms-objects-status">Reading the object list…</p>`;
  else if (result?.error) body = `<p class="bms-objects-status is-error">${escapeHtml(result.error)}</p>`;
  else if (result) {
    result.selected ||= new Set();
    body = `<h3>Analog and binary values</h3>${result.values.length ? table("values", [["type", "Type"], ["instance", "Instance"], ["name", "Name"], ["presentValue", "Present value"]], result.values, result) : `<p class="bms-objects-status">No analog or binary values found.</p>`}
      <h3>Schedules</h3>${result.schedules.length ? table("schedules", [["instance", "Instance"], ["name", "Name"], ["presentValue", "Present value"], ["exceptionSchedule", "Exception events"]], result.schedules.map((object) => ({ ...object, type: "schedule" })), result) : `<p class="bms-objects-status">No schedules found.</p>`}`;
  }
  const count = result?.selected?.size ?? 0;
  const busy = result?.loading || result?.deleting;
  $("#bms-objects-section").innerHTML = `<div class="section-heading"><div><h2>BMS objects</h2></div></div>
    <div class="mqtt-actions"><button class="button button-primary" type="button" data-action="get-bms-objects"${busy ? " disabled" : ""}>Get all objects</button>${count ? `<button class="button button-danger" type="button" data-action="delete-bms-objects"${busy ? " disabled" : ""}>Delete ${count} selected object${count > 1 ? "s" : ""}</button>` : ""}</div>${body}`;
  $("#bms-objects-section").querySelectorAll("[data-indeterminate]").forEach((input) => { input.indeterminate = true; });
}

function renderNavigation() {
  const entries = Object.entries(state.config.deviceProfiles);
  const connections = Object.entries(state.config.connections);
  if (!connections.some(([name]) => name === state.selectedConnection)) state.selectedConnection = connections[0]?.[0] ?? null;
  if (!entries.some(([name]) => name === state.selectedDevice)) state.selectedDevice = entries[0]?.[0] ?? null;
  for (const [view, selector] of [
    ["bms-home", ".rail-title-bms"],
    ["devices-home", ".rail-title-lorawan"]
  ]) {
    $(selector).classList.toggle("is-selected", state.selectedView === view);
  }
  $(".rail-title-zones").classList.toggle("is-selected", state.selectedView === "schedule-global");
  $("[data-select-view='mqtt']").classList.toggle("is-selected", state.selectedView === "mqtt");
  $("#live-logs-button").classList.toggle("is-active", state.selectedView === "log");
  const zones = state.config.zonesSchedules.zones;
  state.selectedZone = zones.length ? Math.min(Math.max(state.selectedZone ?? 0, 0), zones.length - 1) : null;
  $("#zone-navigation").innerHTML = zones.map((zone, index) => `
    <button class="device-nav-item${state.selectedView === "zone" && index === state.selectedZone ? " is-selected" : ""}" type="button" data-select-zone="${index}">
      <span class="device-nav-copy"><strong>${escapeHtml(zone.scheduleName)}${SCHEDULE_ROWS.flat().every((key) => zone[key] === undefined) ? ' <small class="zone-default-tag">Default config</small>' : ""}</strong><small>Occ: ${escapeHtml(String(zone.valueOccupied ?? state.config.zonesSchedules[confKeyOfZone(zone)].defaults.valueOccupied))} · Unocc: ${escapeHtml(String(zone.valueUnOccupied ?? state.config.zonesSchedules[confKeyOfZone(zone)].defaults.valueUnOccupied))}</small></span>
      <span class="zone-toggle ${zone.excluded ? "is-off" : "is-on"}" title="${zone.excluded ? "Excluded" : "Included"}" aria-hidden="true"><i>${zone.excluded ? "✕" : "✓"}</i></span>
      <span class="nav-chevron" aria-hidden="true">›</span>
    </button>`).join("");
  const warningSign = (name) => state.config.connections[name]?.status?.warning
    ? `<span class="warning-sign" title="${escapeHtml(state.config.connections[name].status.warning)}" aria-label="Warning">⚠</span>` : "";
  const statusDot = (name) => {
    const status = state.config.connections[name]?.status?.state;
    return status
      ? `<span class="nav-status-dot ${status === "error" ? "is-disconnected" : "is-connected"}" title="${status === "error" ? "Unreachable" : status === "limited" ? "Connected (limited)" : "Connected"}" aria-hidden="true"></span>` : "";
  };
  $("#connection-navigation").innerHTML = connections.map(([name]) => `
    <button class="device-nav-item connection-nav-item${state.selectedView === "global" && name === state.selectedConnection ? " is-selected" : ""}" type="button" data-select-connection="${escapeHtml(name)}">
      <span class="device-nav-copy"><strong>${escapeHtml(name)}</strong><small>Used by ${Object.values(state.config.deviceConnections).filter((assigned) => assigned === name).length} device profiles</small></span>
      ${warningSign(name)}${statusDot(name)}
    </button>`).join("");
  $("#device-navigation").innerHTML = entries.map(([name, device]) => `
    <button class="device-nav-item${state.selectedView === "device" && name === state.selectedDevice ? " is-selected" : ""}" type="button" data-select-device="${escapeHtml(name)}">
      <span class="device-nav-copy"><strong>${escapeHtml(name)}</strong><small>${Object.keys(device.bacnet?.objects || {}).length} BACnet objects</small></span>
      <span class="nav-chevron" aria-hidden="true">›</span>
    </button>`).join("");
}

function renderCategoryPage() {
  const container = $("#category-page");
  const lists = {
    "bms-home": {
      items: Object.entries(state.config.connections).map(([name, connection]) => `
        <button class="category-list-item" type="button" data-select-connection="${escapeHtml(name)}">
          <span class="category-list-copy">
            <strong>${escapeHtml(name)}${connection.status?.warning ? ` <span class="warning-sign" title="${escapeHtml(connection.status.warning)}" aria-label="Warning">⚠</span>` : ""}</strong>
            <small>BMS IP address: ${escapeHtml(connection.ipAddress || "Not set")}</small>
            <small>BMS protocol: ${escapeHtml({ bacnet: "BACnet", restAPIBacnet: "REST API BACnet" }[connection.protocol] || connection.protocol || "Not set")}</small>
          </span><span class="nav-chevron" aria-hidden="true">›</span>
        </button>`),
      empty: "No BMS connections yet.",
      addAction: "add-connection",
      addLabel: "Add BMS connection"
    },
    "devices-home": {
      title: "Device profiles",
      items: Object.entries(state.config.deviceProfiles).map(([name, device]) => `
        <button class="category-list-item" type="button" data-select-device="${escapeHtml(name)}">
          <span class="category-list-copy">
            <strong>${escapeHtml(name)}</strong>
            <small>BMS connection: ${escapeHtml(state.config.deviceConnections[name] || device.controller?.connectionName || "None")}</small>
            <small>LoRaWAN class: ${escapeHtml(device.lorawan?.class ? `Class ${device.lorawan.class}` : "Not set")}</small>
          </span><span class="nav-chevron" aria-hidden="true">›</span>
        </button>`),
      empty: "No device profiles yet.",
      addAction: "add-device",
      addLabel: "Add device profile"
    }
  };
  const page = lists[state.selectedView];
  container.hidden = !page;
  if (!page) return;

  container.innerHTML = `
    ${page.title ? `<div class="section-heading"><div><h2>${page.title}</h2></div></div>` : ""}
    <div class="category-list">${page.items.join("") || `<div class="empty-objects">${page.empty}</div>`}</div>
    ${page.addAction ? `<button class="add-device-button category-add" type="button" data-action="${page.addAction}"><span aria-hidden="true">+</span> ${page.addLabel}</button>` : ""}
    ${state.selectedView === "bms-home" ? `<button class="add-device-button category-add" type="button" data-action="whois-bms"${state.whoIs?.loading ? " disabled" : ""}><span aria-hidden="true">+</span> Add BMS connection using Who-Is</button>${whoIsResults()}` : ""}`;
}

function whoIsResults() {
  const result = state.whoIs;
  if (!result) return "";
  if (result.loading) return `<p class="bms-objects-status">Sending Who-Is on the local network…</p>`;
  if (result.error) return `<p class="bms-objects-status is-error">${escapeHtml(result.error)}</p>`;
  if (!result.devices.length) return `<p class="bms-objects-status">No BACnet device answered the Who-Is.</p>`;
  return `<h3 class="whois-title">BMS found on the network</h3><div class="bms-objects-table-wrap"><table class="bms-objects-table"><thead><tr><th>Device Name</th><th>IP address</th><th>BACnet ID</th><th></th></tr></thead><tbody>${result.devices.map((device) => `<tr><td>${escapeHtml(device.deviceName)}</td><td>${escapeHtml(device.ipAddress)}</td><td>${device.deviceId}</td><td><button class="add-device-button category-add whois-add" type="button" data-action="add-connection" data-whois-name="${escapeHtml(device.deviceName)}" data-whois-ip="${escapeHtml(device.ipAddress)}"><span aria-hidden="true">+</span> Add this BMS</button></td></tr>`).join("")}</tbody></table></div>`;
}

function renderDevice() {
  const container = $("#device-editor");
  const name = state.selectedDevice;
  if (!name) {
    container.innerHTML = `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">+</div><h2>No device profiles yet</h2><p>Add a device profile to define its LoRaWAN fleet and BACnet points.</p><button class="button button-primary" type="button" data-action="add-device">Add device profile</button></div>`;
    return;
  }

  const device = state.config.deviceProfiles[name];
  const objects = device.bacnet.objects || {};
  const debug = device.controller.debug || [];
  const deviceExpanded = Boolean(state.expandedDevices[name]);
  const assignedConnection = state.config.deviceConnections[name] || "";
  const connectionOptions = [["", "No connection profile"], ...Object.keys(state.config.connections).map((connectionName) => [connectionName, connectionName])];
  const deviceFields = [
    `<div class="field-row">${inputField("Device profile name", "_name", name)}</div>`,
    `<div class="field-row">${selectField("LoRaWAN class", "lorawan.class", device.lorawan?.class || "A", [["A", "Class A"], ["B", "Class B"], ["C", "Class C"]])}</div>`,
    `<div class="field-row">${selectField("BMS connection", "deviceConnection", assignedConnection, connectionOptions).replace("data-path=", "data-device-connection=")}</div>`,
    `<div class="field-row">${inputField("Maximum number of this device", "identity.maxDevNum", device.identity?.maxDevNum, { type: "number", min: 1, step: 1 })}</div>`,
    `<div class="field-row">${selectField("Flush downlink queue", "lorawan.flushDownlinkQueue", String(Boolean(device.lorawan?.flushDownlinkQueue)), [["false", "No"], ["true", "Yes"]])}</div>`,
    `<div class="field-pair">${inputField("First AV instance number", "bacnet.offsetAV", device.bacnet.offsetAV, { type: "number", min: 0, step: 1 })}${inputField("Number of AV for each device", "bacnet.instanceRangeAV", device.bacnet.instanceRangeAV, { type: "number", min: 0, step: 1 })}</div>`,
    `<div class="field-pair">${inputField("First BV instance number", "bacnet.offsetBV", device.bacnet.offsetBV, { type: "number", min: 0, step: 1 })}${inputField("Number of BV for each device", "bacnet.instanceRangeBV", device.bacnet.instanceRangeBV, { type: "number", min: 0, step: 1 })}</div>`
  ];
  let actilityFields = "";
  if (device.lorawan.networkServer === "actility" && hasDownlink(device)) {
    const driver = device.lorawan.actility?.driver || {};
    actilityFields = `<div class="subsection-heading"><div><span class="eyebrow">ACTILITY DOWNLINK</span><h3>Driver identifiers</h3></div></div><div class="field-grid">
      ${inputField("Product ID (pId)", "lorawan.actility.driver.pId", driver.pId || "")}
      ${inputField("Model ID (mId)", "lorawan.actility.driver.mId", driver.mId || "")}
      ${inputField("Version", "lorawan.actility.driver.ver", driver.ver || "")}</div>`;
  }

  container.innerHTML = `
    <div class="section-heading device-heading"><div><h2>LoRaWAN device profile configuration</h2></div></div>
    <section class="device-card${deviceExpanded ? " is-expanded" : ""}">
      <div class="panel-heading-row">
        <button class="panel-toggle" type="button" data-panel-toggle="device" aria-expanded="${deviceExpanded}" aria-controls="device-config-panel">
          <span class="panel-chevron" aria-hidden="true">${deviceExpanded ? "−" : "+"}</span>
          <span class="panel-heading-copy"><span class="eyebrow">DEVICE PROFILE</span><strong>${escapeHtml(name)}</strong></span>
          <span class="mono-tag">${escapeHtml((device.lorawan.networkServer || "unassigned").toUpperCase())}</span>
          <span class="mono-tag">CLASS ${escapeHtml((device.lorawan?.class || "A").toUpperCase())}</span>
          <span class="mono-tag">${escapeHtml(assignedConnection || "NO BMS CONNECTION")}</span>
          <span class="panel-summary-count">${Object.keys(objects).length} objects</span>
        </button>
        <button class="button button-danger-quiet" type="button" data-action="delete-device">Remove</button>
      </div>
      <div id="device-config-panel" class="device-card-body"${deviceExpanded ? "" : " hidden"}>
      <div class="field-grid">${deviceFields.join("")}</div>
      <div class="subsection-heading debug-heading"><div><h3>Message logs</h3></div></div>
      <div class="check-grid">${checkbox("All", debug.includes("all"), "all")}${checkbox("Uplink", debug.includes("up"), "up")}${checkbox("Downlink", debug.includes("down"), "down")}${checkbox("Creation", debug.includes("creation"), "creation")}${checkbox("Transmit time", debug.includes("txTime"), "txTime")}</div>
      <div class="subsection-heading debug-heading"><div><h3>Print device object</h3></div></div>
      <div class="check-grid">${checkbox("After MQTT reception", debug.includes("deviceMqtt"), "deviceMqtt")}${checkbox("After uplink process", debug.includes("deviceUplink"), "deviceUplink")}${checkbox("After downlink process", debug.includes("deviceDownlink"), "deviceDownlink")}</div>
      <div class="subsection-heading debug-heading"><div><h3>Print previousValues object</h3></div></div>
      <div class="check-grid">${checkbox("After MQTT reception", debug.includes("previousValuesMqtt"), "previousValuesMqtt")}</div>
      ${actilityFields}
      </div>
    </section>
    <div class="objects-heading"><div><h2>Mapping between LoRaWAN payloads and BACnet objects <span class="object-count">${Object.keys(objects).length}</span></h2></div><button class="button button-outline" type="button" data-action="add-object">+ Add object</button></div>
    <div class="object-list">${Object.entries(objects).map(([objectName, object]) => renderObject(objectName, object)).join("") || `<div class="empty-objects">No correspondence yet. Add a correspondence between LoRaWAN payload and BACnet object.</div>`}</div>`;
}

function renderObject(name, object) {
  const downlink = object.dataDirection === "downlink";
  const objectKey = `${state.selectedDevice}::${name}`;
  const objectExpanded = Boolean(state.expandedObjects[objectKey]);
  const range = Array.isArray(object.range) ? object.range : [0, 100];
  const instanceLabel = object.assignementMode === "manual" ? "Instance number" : "Instance number offset";
  const uplinkNames = Object.entries(state.config.deviceProfiles[state.selectedDevice]?.bacnet?.objects || {})
    .filter(([, candidate]) => candidate.dataDirection === "uplink")
    .map(([candidateName]) => candidateName);
  if (object.uplinkToCompareWith && !uplinkNames.includes(object.uplinkToCompareWith)) uplinkNames.push(object.uplinkToCompareWith);
  const uplinkObjectOptions = [["", "Select an uplink object"], ...uplinkNames.map((candidateName) => [candidateName, candidateName])];
  const core = [
    `<div class="field-row">${inputField("LoRaWAN payload name", "lorawanPayloadName", object.lorawanPayloadName || "")}</div>`,
    `<div class="field-pair">${inputField("BACnet object name", "_name", name)}${selectField("BACnet Object type", "objectType", object.objectType, [["analogValue", "Analog value"], ["binaryValue", "Binary value"]])}</div>`,
   
    `<div class="field-pair">${selectField("Assignation mode", "assignementMode", object.assignementMode, [["auto", "Automatic"], ["manual", "Manual"]])}${inputField(instanceLabel, "instanceNum", object.instanceNum, { type: "number", min: 0, step: 1 })}</div>`,
    `<div class="field-row">${selectField("Direction", "dataDirection", object.dataDirection, [["uplink", "Uplink"], ["downlink", "Downlink"]])}</div>`
  ];
  const downlinkFields = downlink ? `
    <div class="field-grid downlink-fields">
      <div class="field-row">${inputField("Downlink FPort", "downlinkPort", object.downlinkPort, { type: "number", min: 0, max: 255, step: 1 })}</div>
      <div class="${object.downlinkStrategy?.startsWith("compareToUplinkObject") ? "field-pair" : "field-row"}">${selectField("Downlink strategy", "downlinkStrategy", object.downlinkStrategy, [["compareToUplinkObject", "Compare with the following BACnet uplink object"], ["compareToUplinkObjectWithinRange", "Compare with the following BACnet uplink object within range"], ["onChangeOfThisValue", "On change on BMS"], ["onChangeOfThisValueWithinRange", "On change on BMS within range"]])}${object.downlinkStrategy?.startsWith("compareToUplinkObject") ? selectField("Uplink BACnet object name", "uplinkToCompareWith", object.uplinkToCompareWith || "", uplinkObjectOptions) : ""}</div>
      ${object.downlinkStrategy?.endsWith("WithinRange") ? `<div class="field-row">${inputField("Range minimum", "range.0", range[0], { type: "number", step: "any" })}</div><div class="field-row">${inputField("Range maximum", "range.1", range[1], { type: "number", step: "any" })}</div>` : ""}
      <div class="field-row">${selectField("Priority", "downlinkPortPriority", object.downlinkPortPriority || "low", [["low", "Low"], ["high", "High"]])}</div>
      <div class="field-row">${object.objectType === "binaryValue" ? selectField("Default value when the object is created", "value", object.value ?? 0, [["0", "0 / inactive"], ["1", "1 / active"]]) : inputField("Default value when the object is created", "value", object.value ?? 0, { type: "number", step: "any" })}</div>
    </div>` : "";

  return `<article class="object-card${objectExpanded ? " is-expanded" : ""}" data-object-card="${escapeHtml(name)}">
    <div class="object-card-heading">
      <button class="panel-toggle object-panel-toggle" type="button" data-panel-toggle="object" data-object-name="${escapeHtml(name)}" aria-expanded="${objectExpanded}">
        <span class="panel-chevron" aria-hidden="true">${objectExpanded ? "−" : "+"}</span>
        <span class="object-title"><span class="object-type-mark ${downlink ? "mark-down" : "mark-up"}" aria-hidden="true">${downlink ? "↓" : "↑"}</span><span class="object-title-copy"><strong>${escapeHtml(name)}</strong><small>${downlink ? "Downlink object" : "Uplink object"}</small></span></span>
        <span class="panel-summary-count">${escapeHtml(object.objectType === "binaryValue" ? "Binary value" : "Analog value")}</span>
      </button>
      <button class="button button-danger-quiet button-compact" type="button" data-action="delete-object" data-object-name="${escapeHtml(name)}">Remove</button>
    </div>
    <div class="object-card-body"${objectExpanded ? "" : " hidden"}>
      <div class="field-grid">${core.join("")}</div>${downlinkFields}
    </div>
  </article>`;
}

const TIME_ZONES = ["Europe/Paris", "UTC", "Europe/London", "Europe/Brussels", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Zurich", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];

// Settings shared by the global defaults and every zone (a zone only stores the ones it overrides).
const SCHEDULE_SETTINGS = [
  { key: "groupEvents", kind: "boolean", label: "Merge all daily events into one?" },
  { key: "timeZone", kind: "timezone", label: "Time zone", globalLabel: "Default time zone" },
  { key: "eventsToDiscard", kind: "list", label: "Event names to discard", globalLabel: "Default event names to discard" },
  { key: "minimumSlotDuration", kind: "number", min: 0, label: "Minimum event duration (minutes)" },
  { key: "valueOccupied", kind: "number", label: "Value when the zone is occupied", globalLabel: "Default value when the zone is OCCUPIED" },
  { key: "valueUnOccupied", kind: "number", label: "Value when the zone is unoccupied", globalLabel: "Default value when the zone is UNOCCUPIED" },
  { key: "timeOffsetBeforeStart", kind: "number", min: 0, groupedOnly: true, label: "Start earlier by (minutes)" },
  { key: "timeOffsetBeforeEnd", kind: "number", min: 0, groupedOnly: true, label: "End earlier by (minutes)" },
  { key: "nbrDaysPreview", kind: "number", min: 1, step: 1, label: "Number of days to anticipate", globalLabel: "Default number of days to anticipate" },
  { key: "addSuffixToAdeURL", kind: "boolean", label: "Add <today + days to anticipate> to the ADE URL" },
  { key: "weekly", kind: "json", label: "Weekly schedule", globalLabel: "Default weekly schedule" }
];

function scheduleSettingField(spec, value, attribute, isGlobal) {
  const label = isGlobal ? spec.globalLabel || spec.label : spec.label;
  const attrs = `${attribute}="${spec.key}"`;
  let control;
  if (spec.kind === "boolean") {
    control = `<select ${attrs}>${["true", "false"].map((option) => `<option value="${option}"${String(Boolean(value)) === option ? " selected" : ""}>${option}</option>`).join("")}</select>`;
  } else if (spec.kind === "timezone") {
    const zones = TIME_ZONES.includes(value) ? TIME_ZONES : [...TIME_ZONES, value];
    control = `<select ${attrs}>${zones.map((zone) => `<option value="${escapeHtml(zone)}"${zone === value ? " selected" : ""}>${escapeHtml(zone)}</option>`).join("")}</select>`;
  } else if (spec.kind === "json") {
    control = `<textarea class="code-input" ${attrs} rows="14" spellcheck="false">${escapeHtml(JSON.stringify(value ?? {}, null, 2))}</textarea>`;
  } else if (spec.kind === "list") {
    control = `<input ${attrs} type="text" value="${escapeHtml((value || []).join(", "))}" placeholder="Comma separated values" autocomplete="off">`;
  } else {
    control = `<input ${attrs} type="number" step="${spec.step ?? "any"}"${spec.min !== undefined ? ` min="${spec.min}"` : ""} value="${escapeHtml(value)}" autocomplete="off">`;
  }
  return `<label class="field"><span>${escapeHtml(label)}</span>${control}</label>`;
}

const OCCUPANCY_ROW = ["valueOccupied", "valueUnOccupied"];
const OFFSET_ROW = ["timeOffsetBeforeStart", "timeOffsetBeforeEnd"];
const SCHEDULE_ROWS = [
  ["groupEvents"], ["timeZone"], ["eventsToDiscard"], ["minimumSlotDuration"],
  OCCUPANCY_ROW,
  OFFSET_ROW, ["nbrDaysPreview"], ["addSuffixToAdeURL"], ["weekly"]
];

const SCHEDULE_LOGS = [
  ["eventsAddedInSchedules", "ical Event added in schedules"],
  ["eventTimeCreation", "ical Event time creation"],
  ["scheduleAVUpdate", "Schedule AV update", ICAL_CONF]
];

// Settings that share a row are displayed side by side; the offsets only apply to merged events.
function scheduleSettingRows(rows, valueOf, attribute, isGlobal, grouped) {
  return rows.map((keys) => {
    const specs = keys.map((key) => SCHEDULE_SETTINGS.find((spec) => spec.key === key)).filter((spec) => !spec.groupedOnly || grouped);
    if (!specs.length) return "";
    const fields = specs.map((spec) => scheduleSettingField(spec, valueOf(spec.key), attribute, isGlobal)).join("");
    return `<div class="${specs.length > 1 ? "field-pair" : "field-row"}">${fields}</div>`;
  }).join("");
}

function advancedPanel(key, bodyHtml, title = "Advanced settings") {
  const expanded = Boolean(state.expandedAdvanced[key]);
  return `<section class="device-card advanced-card${expanded ? " is-expanded" : ""}">
    <div class="panel-heading-row">
      <button class="panel-toggle" type="button" data-panel-toggle="advanced" data-advanced-key="${escapeHtml(key)}" aria-expanded="${expanded}">
        <span class="panel-chevron" aria-hidden="true">${expanded ? "−" : "+"}</span>
        <span class="panel-heading-copy"><strong>${escapeHtml(title)}</strong></span>
      </button>
    </div>
    <div class="device-card-body"${expanded ? "" : " hidden"}>${bodyHtml}</div>
  </section>`;
}

// Returns false (after a notice) when the JSON of the weekly schedule is invalid.
function applyScheduleSetting(target, input, key) {
  const spec = SCHEDULE_SETTINGS.find((candidate) => candidate.key === key);
  try {
    if (spec.kind === "boolean") target[key] = input.value === "true";
    else if (spec.kind === "list") target[key] = input.value.split(",").map((item) => item.trim()).filter(Boolean);
    else if (spec.kind === "json") target[key] = JSON.parse(input.value);
    else if (spec.kind === "number") target[key] = inputValue(input);
    else target[key] = input.value;
  } catch {
    showNotice(`${spec.globalLabel || spec.label}: invalid JSON.`, "error");
  }
  render();
}

function downlinkObjectNames(deviceProfile) {
  return Object.entries(state.config.deviceProfiles[deviceProfile]?.bacnet?.objects || {})
    .filter(([, object]) => object.dataDirection === "downlink")
    .map(([name]) => name);
}

function renderScheduleConfSection(confKey, title) {
  const conf = state.config.zonesSchedules[confKey];
  const isIcal = confKey === ICAL_CONF;
  const confField = (label, path, value, options = {}) => inputField(label, path, value, { type: "number", step: 1, ...options }).replace("data-path=", "data-schedule-conf=");
  const grouped = conf.defaults.groupEvents === true;
  const valueOf = (key) => conf.defaults[key];
  const icalOnlyFields = isIcal ? (() => {
    const [first, last] = conf.scheduleInstanceRange;
    return `
    <div class="field-grid">
      <div class="field-row">${confField("ScheduleAV update interval (seconds)", "timeBetweenScheduleAVUpdate", conf.timeBetweenScheduleAVUpdate, { min: 1 })}</div>
      <div class="field-row">${confField("First ScheduleAV instance number", "scheduleAVInstanceOffset", conf.scheduleAVInstanceOffset, { min: 0 })}</div>
    </div>
    <div class="subsection-heading debug-heading"><div><h3>Schedule instance number range</h3></div></div>
    <div class="field-grid"><div class="field-pair">${confField("First instance number", "scheduleInstanceRange.0", first, { min: 0 })}${confField("Last instance number", "scheduleInstanceRange.1", last, { min: 0 })}</div></div>`;
  })() : "";
  const advanced = `
    ${icalOnlyFields}
    <div class="subsection-heading debug-heading"><div><h3>Default zone settings</h3></div></div>
    <div class="field-grid">${scheduleSettingRows(SCHEDULE_ROWS.filter((row) => row !== OCCUPANCY_ROW && row !== OFFSET_ROW), valueOf, "data-schedule-default", true, grouped)}</div>`;
  const logs = SCHEDULE_LOGS.filter(([, , onlyFor]) => !onlyFor || onlyFor === confKey);
  const number = isIcal ? 1 : 2;
  return `<section class="config-section schedule-section schedule-global-config" data-conf-key="${confKey}" aria-label="Global configuration ${number}">
    <div class="section-heading device-heading"><div><p class="eyebrow">Global configuration ${number}</p><h2>${escapeHtml(title)}</h2></div></div>
    <div class="subsection-heading debug-heading"><div><h3>Default basic settings</h3></div></div>
    <div class="field-grid">
      ${scheduleSettingRows([OCCUPANCY_ROW, OFFSET_ROW], valueOf, "data-schedule-default", true, grouped)}
      <div class="field-row">${confField("Schedule update interval (seconds)", "timeBetweenScheduleUpdate", conf.timeBetweenScheduleUpdate, { min: 1 })}</div>
    </div>
    <div class="subsection-heading debug-heading"><div><h3>Message logs</h3></div></div>
    <div class="check-grid">${logs.map(([key, label]) => `<label class="check-field"><input type="checkbox" data-schedule-log="${key}"${conf.logs[key] !== false ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`).join("")}</div>
    ${advancedPanel(isIcal ? "global" : "global-events", advanced, "Default advanced settings")}
  </section>`;
}

function renderScheduleGlobal() {
  $("#schedule-global-editor").innerHTML = SCHEDULE_CONFIGS.map(([key, title]) => renderScheduleConfSection(key, title)).join("");
}

function renderZone() {
  const container = $("#zone-editor");
  const { zones } = state.config.zonesSchedules;
  const zone = zones[state.selectedZone];
  if (!zone) {
    container.innerHTML = `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">+</div><h2>No zones yet</h2><p>Add a zone to synchronise its agenda with a BACnet schedule.</p><button class="button button-primary" type="button" data-action="add-zone">Add zone</button></div>`;
    return;
  }
  const eventsOnly = confKeyOfZone(zone) === EVENTS_CONF;
  const { defaults } = state.config.zonesSchedules[confKeyOfZone(zone)];

  const zoneField = (html) => html.replace("data-path=", "data-zone-field=");
  const connectionNames = Object.keys(state.config.connections);
  if (zone.connectionName && !connectionNames.includes(zone.connectionName)) connectionNames.push(zone.connectionName);
  const connectionOptions = [["", "Select a BMS connection"], ...connectionNames.map((name) => [name, name])];
  const grouped = (zone.groupEvents ?? defaults.groupEvents) === true;
  const deviceProfiles = Object.keys(state.config.deviceProfiles);

  const deviceRows = Object.entries(zone.devices).map(([profileName, device]) => {
    const profileNames = deviceProfiles.includes(profileName) ? deviceProfiles : [profileName, ...deviceProfiles];
    const downlinkNames = downlinkObjectNames(profileName);
    if (device.AVToBindName && !downlinkNames.includes(device.AVToBindName)) downlinkNames.push(device.AVToBindName);
    const deviceField = (html) => html.replace("data-path=", "data-zone-device-field=");
    const deviceExpanded = Boolean(state.expandedZoneDevices[`${state.selectedZone}::${profileName}`]);
    const deviceNumbers = device.deviceNums || [];
    return `<article class="object-card${deviceExpanded ? " is-expanded" : ""}" data-zone-device="${escapeHtml(profileName)}">
      <div class="object-card-heading">
        <button class="panel-toggle object-panel-toggle" type="button" data-panel-toggle="zoneDevice" data-device-profile="${escapeHtml(profileName)}" aria-expanded="${deviceExpanded}">
          <span class="panel-chevron" aria-hidden="true">${deviceExpanded ? "−" : "+"}</span>
          <span class="object-title"><span class="object-type-mark mark-down" aria-hidden="true">↓</span><span class="object-title-copy"><strong>${escapeHtml(profileName)}</strong><small>${escapeHtml(device.AVToBindName || "No object selected")}</small></span></span>
          <span class="panel-summary-count zone-device-numbers">Device: ${escapeHtml(deviceNumbers.join(", ") || "none")}</span>
        </button>
        <button class="button button-danger-quiet button-compact" type="button" data-action="delete-zone-device" data-device-profile="${escapeHtml(profileName)}">Remove</button>
      </div>
      <div class="object-card-body"${deviceExpanded ? "" : " hidden"}><div class="field-grid">
        <div class="field-row">${deviceField(selectField("LoRaWAN device profile", "profile", profileName, profileNames.map((name) => [name, name])))}</div>
        <div class="field-row">${deviceField(inputField("Device numbers (comma separated)", "deviceNums", (device.deviceNums || []).join(", "), { placeholder: "2, 5, 10" }))}</div>
        <div class="field-row">${deviceField(selectField("AVToBindName (downlink object)", "AVToBindName", device.AVToBindName || "", [["", "Select a downlink object"], ...downlinkNames.map((name) => [name, name])]))}</div>
      </div></div>
    </article>`;
  }).join("");

  container.innerHTML = `
    <div class="section-heading device-heading"><div><h2>Zone</h2></div></div>
    <section class="config-section schedule-section${zone.excluded ? " is-zone-excluded" : ""}">
      <div class="section-heading"><div><h2>Basic settings</h2></div>      <div class="heading-actions"><button class="zone-toggle-button" type="button" data-action="toggle-zone-excluded" title="${zone.excluded ? "Excluded – click to include" : "Included – click to exclude"}" aria-label="${zone.excluded ? "Include zone" : "Exclude zone"}"><span class="zone-toggle ${zone.excluded ? "is-off" : "is-on"}" aria-hidden="true"><i>${zone.excluded ? "✕" : "✓"}</i></span></button><button class="button button-outline button-small" type="button" data-action="reset-zone-defaults">Set default</button><button class="button button-danger-quiet button-small" type="button" data-action="delete-zone">Remove</button></div></div>
      <div class="field-grid">
        <div class="field-row">${zoneField(selectField("Global configuration applied to this zone", "configuration", confKeyOfZone(zone), SCHEDULE_CONFIGS))}</div>
        <div class="${eventsOnly ? "field-pair" : "field-row"}">${zoneField(inputField("Zone / schedule name", "scheduleName", zone.scheduleName))}${eventsOnly ? zoneField(inputField("BACnet schedule ID", "scheduleID", zone.scheduleID ?? "", { type: "number", min: 0, step: 1 })) : ""}</div>
        <div class="field-row">${zoneField(selectField("On which BMS will be the BACnet schedule object?", "connectionName", zone.connectionName || "", connectionOptions))}</div>
        <div class="field-row"><div class="zone-url-test">${zoneField(inputField("iCal URL", "url", zone.url, { placeholder: "https://" }))}<button class="button button-primary" type="button" data-action="test-ical">Test</button></div></div>
      </div>
      ${advancedPanel(`zone:${state.selectedZone}`, `<div class="field-grid">${scheduleSettingRows(SCHEDULE_ROWS, (key) => zone[key] ?? defaults[key], "data-zone-field", false, grouped)}</div>`)}
    </section>
    ${eventsOnly ? "" : `<div class="zone-devices${zone.excluded ? " is-zone-excluded" : ""}">
    <div class="objects-heading"><div><h2>Devices <span class="object-count">${Object.keys(zone.devices).length}</span></h2></div><button class="button button-outline" type="button" data-action="add-zone-device">+ Add device</button></div>
    <div class="object-list">${deviceRows || `<div class="empty-objects">No device yet. Add the LoRaWAN devices controlled by this zone schedule.</div>`}</div></div>`}`;
}

function handleZoneField(input) {
  const { zones } = state.config.zonesSchedules;
  const zone = zones[state.selectedZone];
  const key = input.dataset.zoneField;
  if (key === "scheduleName") {
    const name = input.value.trim();
    if (!name || /\s/.test(name) || zones.some((other, index) => index !== state.selectedZone && other.scheduleName === name)) {
      showNotice("Zone names must be unique and cannot be empty or contain spaces.", "error");
      render();
      return;
    }
    zone.scheduleName = name;
  } else if (key === "url") {
    zone.url = input.value.trim();
    input.value = zone.url;
    return;
  } else if (key === "connectionName") {
    zone[key] = input.value.trim();
  } else if (key === "configuration") {
    zone.configuration = input.value;
    if (input.value === EVENTS_CONF) zone.scheduleID ??= "";
    else delete zone.scheduleID;
  } else if (key === "scheduleID") {
    zone.scheduleID = inputValue(input);
  } else {
    applyScheduleSetting(zone, input, key);
    return;
  }
  render();
}

function handleZoneDeviceField(input) {
  const zone = state.config.zonesSchedules.zones[state.selectedZone];
  const profileName = input.closest("[data-zone-device]").dataset.zoneDevice;
  const field = input.dataset.zoneDeviceField;
  if (field === "profile") {
    const newProfileName = input.value;
    if (newProfileName !== profileName) {
      if (Object.hasOwn(zone.devices, newProfileName)) {
        showNotice(`Device profile '${newProfileName}' is already in this zone.`, "error");
      } else {
        zone.devices = Object.fromEntries(Object.entries(zone.devices).map(([key, value]) => (key === profileName
          ? [newProfileName, { deviceNums: value.deviceNums, AVToBindName: downlinkObjectNames(newProfileName)[0] || "" }]
          : [key, value])));
        state.expandedZoneDevices[`${state.selectedZone}::${newProfileName}`] = state.expandedZoneDevices[`${state.selectedZone}::${profileName}`];
        delete state.expandedZoneDevices[`${state.selectedZone}::${profileName}`];
      }
    }
  } else if (field === "deviceNums") {
    const numbers = input.value.split(",").map((item) => item.trim()).filter(Boolean).map(Number);
    if (numbers.some((number) => !Number.isInteger(number) || number < 1)) showNotice("Device numbers must be whole numbers greater than 0, separated by commas.", "error");
    else zone.devices[profileName].deviceNums = numbers;
  } else {
    zone.devices[profileName].AVToBindName = input.value;
  }
  render();
}

function render() {
  renderNavigation();
  renderGlobal();
  renderDevice();
  renderScheduleGlobal();
  renderZone();
  renderCategoryPage();
  const view = state.selectedView;
  $(".global-section").hidden = view !== "global";
  $("#bms-objects-section").hidden = view !== "global" || !state.selectedConnection || !state.config.connections[state.selectedConnection];
  $("#device-editor").hidden = view !== "device";
  $("#schedule-global-editor").hidden = view !== "schedule-global";
  $("#zone-editor").hidden = view !== "zone";
  $("#mqtt-section").hidden = view !== "mqtt";
  $("#log-section").hidden = view !== "log";
  const pages = {
    "bms-home": ["BMS connections"],
    "devices-home": ["LoRaWAN to BACnet", "Manage device profiles and their BACnet mappings."],
    global: [state.selectedConnection || "BMS connections"],
    mqtt: ["MQTT connection"],
    log: ["Message logs", ""],
    "schedule-global": ["Zones & Schedules", "Global configuration"],
    zone: [state.config.zonesSchedules.zones[state.selectedZone]?.scheduleName || "Zones & Schedules", "Specific configuration for this zone "],
    device: ["LoRaWAN to BACnet configuration"]
  };
  [$("#page-title").textContent, $("#page-description").textContent] = pages[view];
}

const ISSUE_LABELS = {
  zone: { scheduleName: "Zone / schedule name", configuration: "Global configuration applied to this zone", scheduleID: "BACnet schedule ID", connectionName: "On which BMS will be the BACnet schedule object", url: "iCal URL", devices: "Devices" },
  zoneDevice: { profile: "LoRaWAN device profile", deviceNums: "Device numbers (comma separated)", AVToBindName: "AVToBindName (downlink object)" },
  conf: { timeBetweenScheduleUpdate: "Schedule update interval (seconds)", timeBetweenScheduleAVUpdate: "ScheduleAV update interval (seconds)", scheduleAVInstanceOffset: "First ScheduleAV instance number", scheduleInstanceRange: "Schedule instance number range", logs: "Message logs", defaults: "Default zone settings" },
  device: { "identity.maxDevNum": "Maximum number of this device", "controller.ipAddress": "BMS IP address", "bacnet.offsetAV": "First AV instance number", "bacnet.instanceRangeAV": "Number of AV for each device", "bacnet.offsetBV": "First BV instance number", "bacnet.instanceRangeBV": "Number of BV for each device", "bacnet.objects": "Assignation mode" },
  object: { objectType: "BACnet Object type", lorawanPayloadName: "LoRaWAN payload name", dataDirection: "Direction", assignementMode: "Assignation mode", instanceNum: "Instance number", downlinkPort: "Downlink FPort", downlinkStrategy: "Downlink strategy", uplinkToCompareWith: "Uplink BACnet object name", range: "Range minimum and maximum" }
};

// Turns a validation path such as "zonesSchedules.zones.3.url" into the title of the matching field.
function formatIssue(issue) {
  if (issue.standalone) return issue.message;
  const parts = String(issue.path ?? "").split(".");
  const settingLabel = (key, preferGlobal) => {
    const setting = SCHEDULE_SETTINGS.find((candidate) => candidate.key === key);
    return setting ? (preferGlobal && setting.globalLabel) || setting.label : null;
  };
  let label = null;
  let context = "";
  if (parts[0] === "zonesSchedules" && parts[1] === "zones" && parts.length >= 4) {
    const zone = state.config.zonesSchedules.zones.filter((candidate) => candidate.excluded !== true)[Number(parts[2])];
    context = zone?.scheduleName ? `zone ${zone.scheduleName}` : "";
    if (parts[3] === "devices" && parts.length >= 6) {
      label = ISSUE_LABELS.zoneDevice[parts[5]];
      context += `${context ? ", " : ""}profile ${parts[4]}`;
    } else {
      label = ISSUE_LABELS.zone[parts[3]] ?? settingLabel(parts[3], false);
    }
  } else if (parts[0] === "zonesSchedules" && parts.length >= 3) {
    const title = SCHEDULE_CONFIGS.find(([key]) => key === parts[1])?.[1];
    label = parts[2] === "defaults" && parts[3] ? settingLabel(parts[3], true) : ISSUE_LABELS.conf[parts[2]];
    context = title ?? "";
  } else if (parts[0] === "deviceProfiles" && parts.length >= 2) {
    context = `profile ${parts[1]}`;
    if (parts.length === 2) label = "Device profile name";
    else if (parts[2] === "bacnet" && parts[3] === "objects" && parts.length >= 5) {
      context += `, object ${parts[4]}`;
      label = parts.length === 5 ? "BACnet object name" : ISSUE_LABELS.object[parts[5]];
    } else label = ISSUE_LABELS.device[parts.slice(2).join(".")];
  } else if (parts[0] === "deviceConnections" && parts[1]) {
    label = "BMS connection";
    context = `profile ${parts[1]}`;
  }
  if (!label) return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
  return `${label}${context ? ` (${context})` : ""}: ${issue.message}`;
}

function showNotice(message, kind = "success", { warning = "" } = {}) {
  fillNotice($("#notice"), message, kind);
  const extra = $("#notice-warning");
  if (warning) fillNotice(extra, warning, "warning");
  else extra.hidden = true;
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(dismissNotice, 10000);
}

function fillNotice(notice, message, kind) {
  const text = document.createElement("span");
  text.className = "notice-message";
  text.textContent = message;
  const closeButton = document.createElement("button");
  closeButton.className = "notice-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close notification");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", dismissNotice);
  notice.replaceChildren(text, closeButton);
  notice.className = `notice notice-${kind}`;
  notice.hidden = false;
}

function dismissNotice() {
  clearTimeout(state.noticeTimer);
  state.noticeTimer = null;
  $("#notice").hidden = true;
  $("#notice-warning").hidden = true;
}

function inputValue(input) {
  if (input.type === "number") return input.value === "" ? "" : Number(input.value);
  return input.value;
}

function renameDevice(oldName, newName) {
  const safeName = newName;
  if (/\s/.test(safeName)) {
    showNotice("Device profile names cannot contain spaces.", "error");
    render();
    return;
  }
  if (!safeName || (safeName !== oldName && Object.hasOwn(state.config.deviceProfiles, safeName))) {
    showNotice("Device profile names must be unique and cannot be empty.", "error");
    render();
    return;
  }
  if (safeName !== oldName) {
    state.config.deviceProfiles[safeName] = state.config.deviceProfiles[oldName];
    delete state.config.deviceProfiles[oldName];
    state.config.deviceConnections[safeName] = state.config.deviceConnections[oldName] || "";
    state.config.deviceProfiles[safeName].controller.connectionName = state.config.deviceConnections[safeName];
    delete state.config.deviceConnections[oldName];
    state.expandedDevices[safeName] = state.expandedDevices[oldName] || false;
    delete state.expandedDevices[oldName];
    for (const [key, expanded] of Object.entries(state.expandedObjects)) {
      if (key.startsWith(`${oldName}::`)) {
        state.expandedObjects[`${safeName}::${key.slice(oldName.length + 2)}`] = expanded;
        delete state.expandedObjects[key];
      }
    }
    state.selectedDevice = safeName;
  }
}

function renameConnection(oldName, newName) {
  const safeName = newName.trim();
  if (!safeName || (safeName !== oldName && Object.hasOwn(state.config.connections, safeName))) {
    showNotice("Connection names must be unique and cannot be empty.", "error");
    render();
    return;
  }
  if (safeName !== oldName) {
    state.config.connections[safeName] = state.config.connections[oldName];
    delete state.config.connections[oldName];
    for (const deviceName of Object.keys(state.config.deviceConnections)) {
      if (state.config.deviceConnections[deviceName] === oldName) state.config.deviceConnections[deviceName] = safeName;
      if (state.config.deviceProfiles[deviceName]?.controller) state.config.deviceProfiles[deviceName].controller.connectionName = state.config.deviceConnections[deviceName];
    }
    state.selectedConnection = safeName;
  }
}

function renameObject(device, oldName, newName) {
  const safeName = newName;
  if (/\s/.test(safeName)) {
    showNotice("Object names cannot contain spaces.", "error");
    render();
    return;
  }
  if (!safeName || (safeName !== oldName && Object.hasOwn(device.bacnet.objects, safeName))) {
    showNotice("Object names must be unique and cannot be empty.", "error");
    render();
    return;
  }
  if (safeName !== oldName) {
    device.bacnet.objects[safeName] = device.bacnet.objects[oldName];
    delete device.bacnet.objects[oldName];
    const oldKey = `${state.selectedDevice}::${oldName}`;
    const newKey = `${state.selectedDevice}::${safeName}`;
    state.expandedObjects[newKey] = state.expandedObjects[oldKey] || false;
    delete state.expandedObjects[oldKey];
  }
}

function syncAssignedConnections() {
  for (const [deviceName, device] of Object.entries(state.config.deviceProfiles)) {
    const connection = state.config.connections[state.config.deviceConnections[deviceName]];
    applyConnection(device, connection, state.config.deviceConnections[deviceName] || "");
  }
}

function setConnectionValue(path, value) {
  const connection = state.config.connections[state.selectedConnection];
  if (!connection) return;
  setPath(connection, path, value);
  applyConnectionToAssignedDevices(state.selectedConnection);
  render();
}

// The editor keeps every zone in one list with an excluded flag; the stored
// format keeps included zones in `zones` and excluded ones in `excludedZones`.
function splitZones(zonesSchedules) {
  const zones = zonesSchedules.zones || [];
  return {
    ...zonesSchedules,
    zones: zones.filter((zone) => zone.excluded !== true).map((zone) => ({ ...zone, excluded: false })),
    excludedZones: zones.filter((zone) => zone.excluded === true).map((zone) => ({ ...zone, excluded: true }))
  };
}

function mergeZones(zonesSchedules) {
  const { excludedZones = [], zones = [], ...rest } = zonesSchedules;
  return {
    ...rest,
    zones: [
      ...zones.map((zone) => ({ ...zone, excluded: false })),
      ...excludedZones.map((zone) => ({ ...zone, excluded: true }))
    ]
  };
}

function downloadConfig() {
  syncAssignedConnections();
  const files = [
    ["device-profiles.json", state.config.deviceProfiles],
    ["mqtt-connections.json", readMqttForm()],
    ["zones-schedules.json", splitZones(state.config.zonesSchedules)],
    ["bms-connections.json", {
      "bms-connections": state.config.connections,
      deviceConnections: state.config.deviceConnections
    }]
  ];
  const entries = files.map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`]);
  const url = URL.createObjectURL(buildZip(entries));
  const link = document.createElement("a");
  link.href = url;
  link.download = "Campus-iot-conf.zip";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal uncompressed (stored) ZIP archive writer.
function buildZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, data);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, data.length, true);
    head.setUint32(24, data.length, true);
    head.setUint16(28, nameBytes.length, true);
    head.setUint32(42, offset, true);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + (part.byteLength ?? part.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// Reads a ZIP archive (stored or deflated entries) into [{ name, text }].
async function readZip(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file.name} is not a valid ZIP archive.`);
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const result = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(pos + 10, true);
    const size = view.getUint32(pos + 20, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    pos += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    let data = bytes.subarray(dataStart, dataStart + size);
    if (method === 8) {
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    } else if (method !== 0) {
      throw new Error(`Unsupported ZIP compression in ${name}.`);
    }
    result.push({ name: name.split("/").pop(), text: decoder.decode(data) });
  }
  return result;
}

// Each BACnet object of the same type (analog/binary value) must have a distinct instance number within its device profile.
function findDuplicateInstanceNumbers() {
  const conflicts = [];
  for (const [deviceName, device] of Object.entries(state.config.deviceProfiles || {})) {
    const byType = new Map();
    for (const [objectName, object] of Object.entries(device.bacnet?.objects || {})) {
      const key = object.objectType;
      if (!byType.has(key)) byType.set(key, new Map());
      const seen = byType.get(key);
      const instanceNum = Number(object.instanceNum);
      if (!seen.has(instanceNum)) seen.set(instanceNum, []);
      seen.get(instanceNum).push(objectName);
    }
    for (const [objectType, seen] of byType) {
      for (const [instanceNum, objectNames] of seen) {
        if (objectNames.length > 1) {
          const typeLabel = objectType === "binaryValue" ? "Binary value" : "Analog value";
          conflicts.push(`${deviceName}: ${typeLabel} objects ${objectNames.join(", ")} share instance number ${instanceNum}.`);
        }
      }
    }
  }
  return conflicts;
}

async function saveConfig() {
  const conflicts = findDuplicateInstanceNumbers();
  if (conflicts.length) {
    showNotice(conflicts.join("\n"), "error");
    return;
  }
  syncAssignedConnections();
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...state.config, zonesSchedules: splitZones(state.config.zonesSchedules) })
  });
  const result = await response.json();
  if (!response.ok) {
    showNotice(result.errors?.map(formatIssue).join("\n") || result.error, "error");
    return;
  }
  const mqttSaved = await saveMqttSettings();
  showNotice(mqttSaved ? "All configuration saved" : "Device profiles saved, but the MQTT connection could not be saved.", mqttSaved ? undefined : "error");
  const warnings = [...(result.warnings ?? []), ...findDuplicateConnections()];
  if (warnings.length) showNotice(`${mqttSaved ? "All configuration saved" : "Saved"} with warning:\n${warnings.join("\n")}`, "warning");
}

function findDuplicateConnections() {
  const groups = new Map();
  for (const [name, connection] of Object.entries(state.config.connections)) {
    const ip = (connection.ipAddress ?? "").trim();
    if (!ip) continue;
    const key = `${ip}|${connection.protocol}`;
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.entries()].filter(([, names]) => names.length > 1).map(([key, names]) => {
    const [ip, protocol] = key.split("|");
    const label = { bacnet: "BACnet", restAPIBacnet: "REST API BACnet" }[protocol] || protocol;
    return `BMS connections ${names.map((name) => `'${name}'`).join(", ")} use the same IP address (${ip}) and protocol (${label}).`;
  });
}

async function loadVersion() {
  try {
    const response = await fetch("/api/health");
    if (response.ok) $("#app-version").textContent = `Version ${(await response.json()).version}`;
  } catch {
    // The version label is optional.
  }
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Configuration endpoint unavailable");
    state.config = await response.json();
    state.config.connections ||= {};
    state.config.deviceConnections ||= {};
    state.config.deviceProfiles ||= {};
    state.config.zonesSchedules = normalizeZonesSchedules(mergeZones(state.config.zonesSchedules || defaultZonesSchedules()));
    for (const deviceName of Object.keys(state.config.deviceProfiles)) state.config.deviceConnections[deviceName] ||= "";
  } catch (error) {
    state.config = defaultConfig();
    showNotice("The server could not be reached. Changes will not persist until it is running.", "error");
  }
  state.configLoaded = true;
  inferNetworkWhenUnsaved();
  render();
}

function setMqttStatus(status) {
  const connectionState = status.state || "disconnected";
  const labels = { connected: "Connected", connecting: "Connecting", error: "Connection error", disconnected: "Disconnected" };
  const headerLabel = connectionState === "disconnected" ? "MQTT offline" : `MQTT ${labels[connectionState] || connectionState}`;
  const dotClass = connectionState === "connected" ? "state-dot-connected"
    : connectionState === "connecting" ? "state-dot-connecting" : "state-dot-offline";
  const header = $("#mqtt-state");
  const dot = document.createElement("span");
  dot.className = `state-dot ${dotClass}`;
  header.replaceChildren(dot, document.createTextNode(headerLabel));
  const stateClass = connectionState === "connected" ? "is-connected" : connectionState === "connecting" ? "is-connecting" : "is-disconnected";
  const sectionState = $("#mqtt-section-state");
  sectionState.textContent = labels[connectionState] || connectionState;
  sectionState.classList.remove("is-connected", "is-connecting", "is-disconnected");
  sectionState.classList.add(stateClass);
  const navDot = $("#mqtt-nav-dot");
  navDot.classList.toggle("is-connected", connectionState === "connected");
  navDot.classList.toggle("is-connecting", connectionState === "connecting");
  navDot.classList.toggle("is-disconnected", connectionState !== "connected" && connectionState !== "connecting");
  $("#mqtt-connect-button").disabled = connectionState === "connecting" || connectionState === "connected";
  $("#mqtt-disconnect-button").disabled = connectionState === "disconnected";
}

function appendMqttLog(entry) {
  const log = $("#mqtt-log");
  const row = document.createElement("article");
  row.className = `mqtt-log-entry mqtt-log-${entry.level}`;
  const meta = document.createElement("div");
  meta.className = "mqtt-log-meta";
  const level = document.createElement("span");
  level.className = "mqtt-log-level";
  level.textContent = entry.level;
  const timestamp = document.createElement("time");
  timestamp.dateTime = entry.timestamp;
  timestamp.textContent = new Date(entry.timestamp).toLocaleTimeString();
  meta.append(level, timestamp);
  const message = document.createElement("pre");
  message.className = "mqtt-log-message";
  message.textContent = entry.message;
  row.append(meta, message, createCopyButton(() => `${entry.level} ${entry.timestamp}\n${entry.message}`));
  prependLogRow(log, row, $("#mqtt-log-count"));
}

function createCopyButton(getText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mqtt-copy-button";
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy log entry");
  button.textContent = "⧉";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = "✓";
    } catch {
      button.textContent = "!";
    }
    setTimeout(() => { button.textContent = "⧉"; }, 1200);
  });
  return button;
}

function appendRawMqttMessage(entry) {
  const log = $("#mqtt-raw-log");
  const row = document.createElement("article");
  row.className = "mqtt-log-entry mqtt-raw-entry";
  const meta = document.createElement("div");
  meta.className = "mqtt-log-meta";
  const timestamp = document.createElement("time");
  timestamp.dateTime = entry.timestamp;
  timestamp.textContent = new Date(entry.timestamp).toLocaleTimeString();
  const topic = document.createElement("span");
  topic.className = "mqtt-log-topic";
  topic.textContent = entry.topic;
  meta.append(timestamp, topic);
  const message = document.createElement("pre");
  message.className = "mqtt-log-message";
  message.textContent = entry.payload;
  row.append(meta, message, createCopyButton(() => `${entry.topic}\n${entry.payload}`));
  prependLogRow(log, row, $("#mqtt-raw-count"));
}

function prependLogRow(log, row, counter) {
  log.querySelector(".mqtt-log-empty")?.remove();
  log.prepend(row);
  while (log.children.length > 300) log.lastElementChild.remove();
  counter.textContent = `${log.querySelectorAll(".mqtt-log-entry").length} entries`;
  log.scrollTop = 0;
}

function clearLog(logId) {
  const log = $(`#${logId}`);
  log.innerHTML = `<div class="mqtt-log-empty">${logId === "mqtt-raw-log" ? "No raw MQTT messages yet." : "No activity yet."}</div>`;
  $(logId === "mqtt-raw-log" ? "#mqtt-raw-count" : "#mqtt-log-count").textContent = "0 entries";
}

function readMqttForm() {
  const form = {};
  for (const field of MQTT_TEXT_FIELDS) form[field] = $(`#mqtt-${field}`).value;
  form.autoConnect = $("#mqtt-auto-connect").checked;
  return form;
}

async function saveMqttSettings() {
  try {
    const response = await fetch("/api/mqtt/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readMqttForm())
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function loadMqttSettings() {
  try {
    const response = await fetch("/api/mqtt/settings");
    if (!response.ok) return;
    const settings = await response.json();
    for (const field of MQTT_TEXT_FIELDS) {
      if (settings[field]) $(`#mqtt-${field}`).value = settings[field];
    }
    $("#mqtt-auto-connect").checked = settings.autoConnect === true;
    state.mqttNetworkSaved = Boolean(settings.networkServer);
    toggleChirpstackFields();
    if (state.mqttNetworkSaved) applyNetworkPrefill(true);
  } catch {
    // Saved settings are optional.
  } finally {
    state.mqttLoaded = true;
    inferNetworkWhenUnsaved();
  }
}

async function connectMqtt() {
  const settings = readMqttForm();
  await saveMqttSettings();
  try {
    const response = await fetch("/api/mqtt/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to connect to the MQTT broker.");
    setMqttStatus(result);
    await refreshMqtt();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function disconnectMqtt() {
  try {
    const response = await fetch("/api/mqtt/disconnect", { method: "POST" });
    if (!response.ok) throw new Error("Unable to disconnect from the MQTT broker.");
    setMqttStatus(await response.json());
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function refreshMqtt() {
  try {
    const [statusResponse, logsResponse, rawResponse] = await Promise.all([
      fetch("/api/mqtt/status"),
      fetch(`/api/mqtt/logs?after=${state.mqttLogId}`),
      fetch(`/api/mqtt/raw?after=${state.mqttRawId}`)
    ]);
    if (!statusResponse.ok || !logsResponse.ok || !rawResponse.ok) return;
    setMqttStatus(await statusResponse.json());
    const result = await logsResponse.json();
    for (const entry of state.paused.log ? [] : result.entries) {
      appendMqttLog(entry);
      state.mqttLogId = entry.id;
    }
    for (const entry of state.paused.raw ? [] : (await rawResponse.json()).entries) {
      appendRawMqttMessage(entry);
      state.mqttRawId = entry.id;
    }
  } catch {
    setMqttStatus({ state: "disconnected" });
  }
}

document.addEventListener("change", (event) => {
  const input = event.target;
  if (input.matches("[data-bms-select], [data-bms-select-all]")) {
    const result = state.bmsObjects?.[state.selectedConnection];
    if (!result?.selected) return;
    if (input.dataset.bmsSelectAll) {
      const objects = input.dataset.bmsSelectAll === "values" ? result.values : result.schedules.map((object) => ({ ...object, type: "schedule" }));
      for (const object of objects) input.checked ? result.selected.add(objectKey(object)) : result.selected.delete(objectKey(object));
    } else {
      input.checked ? result.selected.add(input.dataset.bmsSelect) : result.selected.delete(input.dataset.bmsSelect);
    }
    renderBmsObjects(state.selectedConnection);
    return;
  }
  if (input.matches("#global-form [data-connection-field]")) {
    setConnectionValue(input.dataset.connectionField, inputValue(input));
    return;
  }
  if (input.matches("#mqtt-networkServer")) {
    applyNetworkPrefill();
    toggleChirpstackFields();
    syncAssignedConnections();
    render();
    return;
  }
  if (input.matches("#mqtt-chirpstack-fields input")) {
    syncAssignedConnections();
    return;
  }
  if (input.matches("#connection-name")) {
    renameConnection(state.selectedConnection, input.value);
    render();
    return;
  }
  if (input.matches("#schedule-global-editor [data-schedule-conf]")) {
    setPath(state.config.zonesSchedules[input.closest("[data-conf-key]").dataset.confKey], input.dataset.scheduleConf, inputValue(input));
    render();
    return;
  }
  if (input.matches("#schedule-global-editor [data-schedule-log]")) {
    state.config.zonesSchedules[input.closest("[data-conf-key]").dataset.confKey].logs[input.dataset.scheduleLog] = input.checked;
    return;
  }
  if (input.matches("#schedule-global-editor [data-schedule-default]")) {
    applyScheduleSetting(state.config.zonesSchedules[input.closest("[data-conf-key]").dataset.confKey].defaults, input, input.dataset.scheduleDefault);
    return;
  }
  if (input.matches("#zone-editor [data-zone-field]")) {
    handleZoneField(input);
    return;
  }
  if (input.matches("#zone-editor [data-zone-device-field]")) {
    handleZoneDeviceField(input);
    return;
  }

  const device = state.config.deviceProfiles[state.selectedDevice];
  if (!device) return;
  if (input.matches("#device-editor [data-device-connection]")) {
    const connectionName = input.value;
    state.config.deviceConnections[state.selectedDevice] = connectionName;
    applyConnection(device, state.config.connections[connectionName], connectionName);
    render();
    return;
  }
  if (input.matches("#device-editor [data-debug]")) {
    const key = input.dataset.debug;
    const debug = device.controller.debug || [];
    if (key === "all") {
      device.controller.debug = debug.filter((item) => item !== "all");
      if (input.checked) device.controller.debug.push("all");
    } else {
      device.controller.debug = debug.slice();
      if (input.checked) device.controller.debug.push(key);
      else device.controller.debug = device.controller.debug.filter((item) => item !== key);
    }
    renderDevice();
    return;
  }

  if (input.matches("#device-editor [data-path]")) {
    const card = input.closest("[data-object-card]");
    if (input.dataset.path === "_name" && card) {
      renameObject(device, card.dataset.objectCard, inputValue(input));
      render();
      return;
    }
    if (input.dataset.path === "_name") {
      renameDevice(state.selectedDevice, inputValue(input));
      render();
      return;
    }
    const objectName = card?.dataset.objectCard;
    const target = objectName ? device.bacnet.objects[objectName] : device;
    const value = inputValue(input);
    if (input.dataset.path === "lorawanPayloadName" && /\s/.test(value)) {
      showNotice("LoRaWAN payload names cannot contain spaces.", "error");
      render();
      return;
    }
    setPath(target, input.dataset.path, input.type === "checkbox" ? input.checked : value);
    if (input.dataset.path === "dataDirection") {
      applyConnection(device, state.config.connections[state.config.deviceConnections[state.selectedDevice]], state.config.deviceConnections[state.selectedDevice]);
      render();
      return;
    }
    if (input.dataset.path === "objectType" && objectName && target.assignementMode !== "manual") {
      target.instanceNum = nextInstanceOffset(device, value, objectName);
    }
    if (["objectType", "assignementMode", "downlinkStrategy"].includes(input.dataset.path)) renderDevice();
  }
});

document.addEventListener("click", async (event) => {
  const clearButton = event.target.closest("[data-clear-log]");
  if (clearButton) clearLog(clearButton.dataset.clearLog);
  const toggleButton = event.target.closest("[data-toggle-log]");
  if (toggleButton) {
    const key = toggleButton.dataset.toggleLog;
    state.paused[key] = !state.paused[key];
    toggleButton.textContent = state.paused[key] ? "Resume" : "Suspend";
  }
  if (event.target.closest("#mqtt-connect-button")) {
    await connectMqtt();
    return;
  }
  if (event.target.closest("#mqtt-disconnect-button")) {
    await disconnectMqtt();
    return;
  }

  const panelToggle = event.target.closest("[data-panel-toggle]");
  if (panelToggle) {
    const expanded = panelToggle.getAttribute("aria-expanded") !== "true";
    panelToggle.setAttribute("aria-expanded", String(expanded));
    panelToggle.querySelector(".panel-chevron").textContent = expanded ? "−" : "+";
    if (panelToggle.dataset.panelToggle === "advanced") {
      state.expandedAdvanced[panelToggle.dataset.advancedKey] = expanded;
      panelToggle.closest(".device-card").querySelector(".device-card-body").hidden = !expanded;
      panelToggle.closest(".device-card").classList.toggle("is-expanded", expanded);
    } else if (panelToggle.dataset.panelToggle === "zoneDevice") {
      state.expandedZoneDevices[`${state.selectedZone}::${panelToggle.dataset.deviceProfile}`] = expanded;
      panelToggle.closest(".object-card").querySelector(".object-card-body").hidden = !expanded;
      panelToggle.closest(".object-card").classList.toggle("is-expanded", expanded);
    } else if (panelToggle.dataset.panelToggle === "device") {
      state.expandedDevices[state.selectedDevice] = expanded;
      $("#device-config-panel").hidden = !expanded;
      panelToggle.closest(".device-card").classList.toggle("is-expanded", expanded);
    } else {
      const objectName = panelToggle.dataset.objectName;
      const objectKey = `${state.selectedDevice}::${objectName}`;
      state.expandedObjects[objectKey] = expanded;
      panelToggle.closest(".object-card").querySelector(".object-card-body").hidden = !expanded;
      panelToggle.closest(".object-card").classList.toggle("is-expanded", expanded);
    }
    return;
  }

  const selectButton = event.target.closest("[data-select-device]");
  if (selectButton) {
    state.selectedDevice = selectButton.dataset.selectDevice;
    state.selectedView = "device";
    render();
    return;
  }

  const zoneButton = event.target.closest("[data-select-zone]");
  if (zoneButton) {
    state.selectedZone = Number(zoneButton.dataset.selectZone);
    state.selectedView = "zone";
    render();
    return;
  }

  const viewButton = event.target.closest("[data-select-view]");
  if (viewButton) {
    state.selectedView = viewButton.dataset.selectView;
    render();
    return;
  }

  const connectionButton = event.target.closest("[data-select-connection]");
  if (connectionButton) {
    state.selectedConnection = connectionButton.dataset.selectConnection;
    state.selectedView = "global";
    render();
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const device = state.config.deviceProfiles[state.selectedDevice];
    const stayOnCategoryPage = actionButton.classList.contains("category-add");
    switch (actionButton.dataset.action) {
      case "add-device": {
        const base = "loraDevice";
        let index = 0;
        const letters = (n) => (n >= 26 ? letters(Math.floor(n / 26) - 1) : "") + String.fromCharCode(65 + (n % 26));
        while (Object.hasOwn(state.config.deviceProfiles, `${base}${letters(index)}`)) index += 1;
        const name = `${base}${letters(index)}`;
        const connectionName = state.selectedConnection || Object.keys(state.config.connections)[0] || "";
        state.config.deviceProfiles[name] = makeDevice(name, connectionName);
        state.expandedDevices[name] = true;
        state.selectedDevice = name;
        if (!stayOnCategoryPage) state.selectedView = "device";
        break;
      }
      case "delete-device":
        if (device && confirm(`Remove device profile '${state.selectedDevice}' and its objects?`)) {
          delete state.config.deviceProfiles[state.selectedDevice];
          delete state.config.deviceConnections[state.selectedDevice];
          delete state.expandedDevices[state.selectedDevice];
          for (const key of Object.keys(state.expandedObjects)) {
            if (key.startsWith(`${state.selectedDevice}::`)) delete state.expandedObjects[key];
          }
          state.selectedDevice = Object.keys(state.config.deviceProfiles)[0] || null;
        }
        break;
      case "add-connection": {
        const discovered = actionButton.dataset.whoisIp ? actionButton.dataset : null;
        let connectionName = discovered?.whoisName?.trim() || "";
        if (!connectionName) {
          let index = 1;
          while (Object.hasOwn(state.config.connections, `Connection ${index}`)) index += 1;
          connectionName = `Connection ${index}`;
        } else if (Object.hasOwn(state.config.connections, connectionName)) {
          let index = 2;
          while (Object.hasOwn(state.config.connections, `${connectionName} ${index}`)) index += 1;
          connectionName = `${connectionName} ${index}`;
        }
        state.config.connections[connectionName] = { ...defaultConnection(), ...(discovered ? { ipAddress: discovered.whoisIp } : {}) };
        state.selectedConnection = connectionName;
        if (!stayOnCategoryPage) state.selectedView = "global";
        break;
      }
      case "test-connection": {
        const connection = state.config.connections[state.selectedConnection];
        if (!connection) break;
        const name = state.selectedConnection;
        showNotice("Testing BMS connection…", "success");
        const { status: previousStatus, ...connectionSettings } = connection;
        try {
          const response = await fetch("/api/bms/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(connectionSettings) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "BMS connection test failed.");
          connection.status = result.warning
            ? { state: "limited", warning: result.warning, testedAt: new Date().toISOString() }
            : { state: "ok", testedAt: new Date().toISOString() };
          showNotice(result.message, "success", { warning: result.warning });
        } catch (error) {
          connection.status = { state: "error", testedAt: new Date().toISOString() };
          showNotice(error.message, "error");
        }
        render();
        break;
      }
      case "sort-bms-objects": {
        const result = state.bmsObjects?.[state.selectedConnection];
        if (!result) break;
        const { group, key } = actionButton.dataset;
        result.sort ||= {};
        const current = result.sort[group];
        result.sort[group] = { key, dir: current?.key === key && current.dir === "asc" ? "desc" : "asc" };
        renderBmsObjects(state.selectedConnection);
        break;
      }
      case "delete-bms-objects": {
        const connectionName = state.selectedConnection;
        const connection = state.config.connections[connectionName];
        const result = state.bmsObjects?.[connectionName];
        if (!connection || !result?.selected?.size) break;
        const objects = [...result.selected].map((key) => {
          const [type, instance] = key.split(":");
          return { type, instance: Number(instance) };
        });
        if (!confirm(`Delete ${objects.length} object${objects.length > 1 ? "s" : ""} on the BMS '${connectionName}'? This cannot be undone.`)) break;
        result.deleting = true;
        renderBmsObjects(connectionName);
        try {
          const response = await fetch("/api/bms/objects/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection, objects }) });
          const outcome = await response.json();
          if (!response.ok) throw new Error(outcome.error || "Deleting the objects failed.");
          const failedKeys = new Set(outcome.failed.map(objectKey));
          result.values = result.values.filter((object) => failedKeys.has(objectKey(object)) || !result.selected.has(objectKey(object)));
          result.schedules = result.schedules.filter((object) => failedKeys.has(`schedule:${object.instance}`) || !result.selected.has(`schedule:${object.instance}`));
          result.selected = new Set(failedKeys);
          if (outcome.failed.length) showNotice(`Deleted ${outcome.deleted}, failed ${outcome.failed.length}: ${outcome.failed[0].error}`, "error");
          else showNotice(`Deleted ${outcome.deleted} object${outcome.deleted > 1 ? "s" : ""}.`, "success");
        } catch (error) {
          showNotice(error.message, "error");
        }
        result.deleting = false;
        renderBmsObjects(connectionName);
        break;
      }
      case "whois-bms": {
        state.whoIs = { loading: true };
        render();
        try {
          const response = await fetch("/api/bms/who-is", { method: "POST" });
          const result = await response.json();
          state.whoIs = response.ok ? { devices: result.devices } : { error: result.error || "The Who-Is failed." };
        } catch (error) {
          state.whoIs = { error: error.message };
        }
        break;
      }
      case "get-bms-objects": {
        const connectionName = state.selectedConnection;
        const connection = state.config.connections[connectionName];
        if (!connection) break;
        state.bmsObjects ||= {};
        state.bmsObjects[connectionName] = { loading: true };
        render();
        try {
          const response = await fetch("/api/bms/objects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(connection) });
          const result = await response.json();
          state.bmsObjects[connectionName] = response.ok ? { values: result.values, schedules: result.schedules } : { error: result.error || "Reading the object list failed." };
        } catch (error) {
          state.bmsObjects[connectionName] = { error: error.message };
        }
        break;
      }
      case "test-ical": {
        const zone = state.config.zonesSchedules.zones[state.selectedZone];
        if (!zone) break;
        actionButton.disabled = true;
        showNotice("Testing iCalendar URL…", "success");
        try {
          const response = await fetch("/api/zones/test-ical", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: zone.url })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "iCalendar URL test failed.");
          showNotice(result.message, "success");
        } catch (error) {
          showNotice(error.message, "error");
        } finally {
          actionButton.disabled = false;
        }
        break;
      }
      case "delete-connection":
        if (state.selectedConnection && confirm(`Remove connection '${state.selectedConnection}'? Assigned devices will keep their current settings.`)) {
          const removedName = state.selectedConnection;
          delete state.config.connections[removedName];
          for (const deviceName of Object.keys(state.config.deviceConnections)) {
            if (state.config.deviceConnections[deviceName] === removedName) {
              state.config.deviceConnections[deviceName] = "";
              if (state.config.deviceProfiles[deviceName]?.controller) state.config.deviceProfiles[deviceName].controller.connectionName = "";
            }
          }
          state.selectedConnection = Object.keys(state.config.connections)[0] || null;
        }
        break;
      case "add-zone": {
        const { zones } = state.config.zonesSchedules;
        let index = zones.length + 1;
        while (zones.some((zone) => zone.scheduleName === `zone-${index}`)) index += 1;
        zones.push({ scheduleName: `zone-${index}`, configuration: ICAL_CONF, connectionName: Object.keys(state.config.connections)[0] || "", url: "", excluded: false, devices: {} });
        state.selectedZone = zones.length - 1;
        state.selectedView = "zone";
        break;
      }
      case "reset-zone-defaults": {
        const zone = state.config.zonesSchedules.zones[state.selectedZone];
        if (!zone) break;
        // Zones only store overrides; removing them makes the zone inherit the global defaults.
        for (const key of SCHEDULE_ROWS.flat()) delete zone[key];
        showNotice(`Zone '${zone.scheduleName}' now uses the global defaults.`);
        break;
      }
      case "toggle-zone-excluded": {
        const zone = state.config.zonesSchedules.zones[state.selectedZone];
        if (zone) zone.excluded = !zone.excluded;
        break;
      }
      case "delete-zone": {
        const { zones } = state.config.zonesSchedules;
        const zone = zones[state.selectedZone];
        if (zone && confirm(`Remove zone '${zone.scheduleName}'?`)) {
          zones.splice(state.selectedZone, 1);
          // Expansion state is keyed by zone position, which has just shifted.
          state.expandedZoneDevices = {};
          for (const key of Object.keys(state.expandedAdvanced)) if (key.startsWith("zone:")) delete state.expandedAdvanced[key];
        }
        break;
      }
      case "add-zone-device": {
        const zone = state.config.zonesSchedules.zones[state.selectedZone];
        const profileName = Object.keys(state.config.deviceProfiles).find((name) => !Object.hasOwn(zone.devices, name));
        if (!profileName) {
          showNotice("All LoRaWAN device profiles are already in this zone, or none exists yet.", "error");
          break;
        }
        zone.devices[profileName] = { deviceNums: [], AVToBindName: downlinkObjectNames(profileName)[0] || "" };
        state.expandedZoneDevices[`${state.selectedZone}::${profileName}`] = true;
        break;
      }
      case "delete-zone-device":
        delete state.config.zonesSchedules.zones[state.selectedZone].devices[actionButton.dataset.deviceProfile];
        delete state.expandedZoneDevices[`${state.selectedZone}::${actionButton.dataset.deviceProfile}`];
        break;
      case "add-object": {
        const base = "object";
        let index = 1;
        while (Object.hasOwn(device.bacnet.objects, `${base}-${index}`)) index += 1;
        const objectName = `${base}-${index}`;
        device.bacnet.objects[objectName] = makeObject();
        device.bacnet.objects[objectName].instanceNum = nextInstanceOffset(device, "analogValue", objectName);
        state.expandedObjects[`${state.selectedDevice}::${objectName}`] = true;
        break;
      }
      case "delete-object":
        delete device.bacnet.objects[actionButton.dataset.objectName];
        delete state.expandedObjects[`${state.selectedDevice}::${actionButton.dataset.objectName}`];
        applyConnection(device, state.config.connections[state.config.deviceConnections[state.selectedDevice]], state.config.deviceConnections[state.selectedDevice]);
        break;
      default:
        return;
    }
    render();
    return;
  }

  if (event.target.closest("#save-button")) await saveConfig();
  if (event.target.closest("#export-button")) downloadConfig();
  if (event.target.closest("#import-button")) $("#import-file").click();
  if (event.target.closest("#edit-json-button")) {
    $("#json-input").value = JSON.stringify(state.config.deviceProfiles, null, 2);
    $("#json-errors").hidden = true;
    $("#json-dialog").showModal();
  }
  if (event.target.closest("#apply-json-button")) {
    try {
        const imported = JSON.parse($("#json-input").value);
      if (!imported || typeof imported !== "object" || Array.isArray(imported)) throw new Error("Device profiles must be a JSON object.");
        const importedConnections = rebuildConnectionsFromDeviceProfiles(imported);
        const candidate = { ...state.config, ...importedConnections, deviceProfiles: imported };
      const response = await fetch("/api/config/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(candidate) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.errors.map(formatIssue).join("\n"));
      state.config.deviceProfiles = imported;
      state.config.connections = importedConnections.connections;
      state.config.deviceConnections = importedConnections.deviceConnections;
      inferNetworkFromProfiles(imported);
      syncAssignedConnections();
      state.expandedDevices = {};
      state.expandedObjects = {};
      state.selectedDevice = Object.keys(imported)[0] || null;
      state.selectedView = "device";
      $("#json-dialog").close();
      render();
      showNotice("Device profiles JSON applied.");
    } catch (error) {
      $("#json-errors").textContent = error.message;
      $("#json-errors").hidden = false;
    }
  }
});

$("#import-file").addEventListener("change", async (event) => {
  const selected = Array.from(event.target.files || []);
  if (!selected.length) return;
  try {
    const files = [];
    for (const file of selected) {
      if (/\.zip$/i.test(file.name)) {
        for (const entry of await readZip(file)) {
          if (/\.json$/i.test(entry.name)) files.push({ name: entry.name, text: entry.text });
        }
      } else {
        files.push({ name: file.name, text: await file.text() });
      }
    }
    if (!files.length) throw new Error("No JSON configuration file found.");
    const importedFiles = files.map((file) => ({
      filename: file.name.toLowerCase(),
      value: JSON.parse(file.text)
    }));
    const imported = {};
    for (const [index, file] of importedFiles.entries()) {
      let kind;
      if (file.filename === "device-profiles.json" || file.filename === "deviceprofiles.json" || file.filename === "devicelist.json") kind = "deviceProfiles";
      else if (file.filename === "mqtt-connections.json" || file.filename === "mqtt-connection.json") kind = "mqtt";
      else if (file.filename === "zones-schedules.json") kind = "zonesSchedules";
      else if (file.filename === "bms-connections.json" || file.filename === "connections.json") kind = "bmsConnections";
      else if (files.length === 1 || file.value?.deviceProfiles) kind = "deviceProfiles";
      else throw new Error(`Unrecognized configuration file: ${files[index].name}`);
      if (Object.hasOwn(imported, kind)) throw new Error(`More than one ${kind} file was selected.`);
      imported[kind] = file.value;
    }

    const candidate = structuredClone(state.config);
    if (imported.deviceProfiles !== undefined) {
      const importedProfiles = imported.deviceProfiles.deviceProfiles || imported.deviceProfiles.deviceList || imported.deviceProfiles;
      if (!importedProfiles || typeof importedProfiles !== "object" || Array.isArray(importedProfiles)) {
        throw new Error("Expected a device profiles JSON object.");
      }
      if (Object.values(importedProfiles).some((device) => !device || typeof device !== "object" || Array.isArray(device))) {
        throw new Error("Every device-profile entry must be a JSON object.");
      }
      candidate.deviceProfiles = importedProfiles;
      const rebuilt = rebuildConnectionsFromDeviceProfiles(importedProfiles);
      candidate.connections = rebuilt.connections;
      candidate.deviceConnections = rebuilt.deviceConnections;
    }
    if (imported.bmsConnections !== undefined) {
      const bmsData = imported.bmsConnections;
      const bmsConnections = bmsData?.["bms-connections"] || bmsData?.connections;
      if (!bmsConnections || typeof bmsConnections !== "object" || Array.isArray(bmsConnections)) {
        throw new Error("Expected a BMS connections JSON object.");
      }
      candidate.connections = bmsConnections;
      if (bmsData.deviceConnections !== undefined) {
        if (!bmsData.deviceConnections || typeof bmsData.deviceConnections !== "object" || Array.isArray(bmsData.deviceConnections)) {
          throw new Error("Expected deviceConnections to be a JSON object.");
        }
        candidate.deviceConnections = bmsData.deviceConnections;
      }
    }
    const importedMqtt = imported.mqtt;
    const importNetwork = importedMqtt?.networkServer
      ? { networkServer: importedMqtt.networkServer, grpcApiKey: importedMqtt.grpcApiKey, serverAddress: importedMqtt.serverAddress, grpcPort: importedMqtt.grpcPort }
      : (imported.deviceProfiles !== undefined ? networkFromProfiles(candidate.deviceProfiles) : null) || networkSettings();
    for (const [deviceName, device] of Object.entries(candidate.deviceProfiles)) {
      const connectionName = candidate.deviceConnections?.[deviceName] || device.controller?.connectionName || "";
      candidate.deviceConnections[deviceName] = connectionName;
      applyConnection(device, candidate.connections[connectionName], connectionName, importNetwork);
    }
    if (imported.zonesSchedules !== undefined) {
      if (!imported.zonesSchedules || typeof imported.zonesSchedules !== "object" || Array.isArray(imported.zonesSchedules)) {
        throw new Error("Expected a zones-schedules JSON object.");
      }
      candidate.zonesSchedules = mergeZones(imported.zonesSchedules);
    }
    if (candidate.zonesSchedules.icalToScheduleConf && typeof candidate.zonesSchedules.icalToScheduleConf === "object") {
      normalizeZonesSchedules(candidate.zonesSchedules);
    }
    const mqttSettings = imported.mqtt;
    if (mqttSettings !== undefined && (!mqttSettings || typeof mqttSettings !== "object" || Array.isArray(mqttSettings))) {
      throw new Error("Expected an MQTT connections JSON object.");
    }
    if (mqttSettings?.autoConnect !== undefined && typeof mqttSettings.autoConnect !== "boolean") {
      throw new Error("MQTT autoConnect must be a boolean.");
    }

    const validation = await fetch("/api/config/validate?zonesSchedules=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...candidate, zonesSchedules: splitZones(candidate.zonesSchedules) })
    });
    const validationResult = await validation.json();
    if (!validation.ok) {
      throw new Error(validationResult.errors?.map(formatIssue).join("\n") || "Imported configuration is invalid.");
    }

    state.config = candidate;
    if (importNetwork) showNetworkSettings(importNetwork);
    if (importedMqtt?.networkServer) state.mqttNetworkSaved = true;
    if (mqttSettings !== undefined) {
      for (const field of MQTT_TEXT_FIELDS) {
        if (field !== "networkServer" && mqttSettings[field] !== undefined) $(`#mqtt-${field}`).value = String(mqttSettings[field]);
      }
      if (mqttSettings.autoConnect !== undefined) $("#mqtt-auto-connect").checked = mqttSettings.autoConnect === true;
    }
    state.expandedDevices = {};
    state.expandedObjects = {};
    state.selectedDevice = Object.keys(candidate.deviceProfiles)[0] || null;
    state.selectedView = "device";
    render();
    showNotice(`${files.length} JSON file${files.length === 1 ? "" : "s"} imported. Save to persist this configuration.`);
  } catch (error) {
    showNotice(`Import failed: ${error.message}`, "error");
  }
  event.target.value = "";
});

loadConfig();
loadMqttSettings();
loadVersion();
clearLog("mqtt-log");
clearLog("mqtt-raw-log");
refreshMqtt();
setInterval(refreshMqtt, 1200);